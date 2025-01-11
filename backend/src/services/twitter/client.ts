import { Scraper, SearchMode, Tweet } from "agent-twitter-client";
import { ADMIN_ACCOUNTS } from "config/admins";
import { broadcastUpdate } from "index";
import {
  Moderation,
  TwitterConfig,
  TwitterSubmission,
} from "../../types/twitter";
import { ExportManager } from "../exports/manager";
import {
  TwitterCookie,
  cacheCookies,
  ensureCacheDirectory,
  getCachedCookies,
  getLastCheckedTweetId,
  saveLastCheckedTweetId,
} from "../../utils/cache";
import { logger } from "../../utils/logger";
import { db } from "../db";

export class TwitterService {
  private client: Scraper;
  private readonly DAILY_SUBMISSION_LIMIT = 10;
  private twitterUsername: string;
  private config: TwitterConfig;
  private isInitialized = false;
  private checkInterval: NodeJS.Timer | null = null;
  private lastCheckedTweetId: string | null = null;
  private configuredTweetId: string | null = null;
  private adminIdCache: Map<string, string> = new Map();

  constructor(
    config: TwitterConfig,
    private readonly exportManager?: ExportManager
  ) {
    this.client = new Scraper();
    this.twitterUsername = config.username;
    this.config = config;
  }

  private async setCookiesFromArray(cookiesArray: TwitterCookie[]) {
    const cookieStrings = cookiesArray.map(
      (cookie) =>
        `${cookie.key}=${cookie.value}; Domain=${cookie.domain}; Path=${cookie.path}; ${
          cookie.secure ? "Secure" : ""
        }; ${cookie.httpOnly ? "HttpOnly" : ""}; SameSite=${
          cookie.sameSite || "Lax"
        }`,
    );
    await this.client.setCookies(cookieStrings);
  }

  private async initializeAdminIds() {
    for (const handle of ADMIN_ACCOUNTS) {
      try {
        const userId = await this.client.getUserIdByScreenName(handle);
        this.adminIdCache.set(userId, handle);
        logger.info(`Cached admin ID for @${handle}: ${userId}`);
      } catch (error) {
        logger.error(`Failed to fetch ID for admin handle @${handle}:`, error);
      }
    }
  }

  private isAdmin(userId: string): boolean {
    return this.adminIdCache.has(userId);
  }

  async initialize() {
    try {
      // Ensure cache directory exists
      await ensureCacheDirectory();

      // Check for cached cookies
      const cachedCookies = await getCachedCookies(this.twitterUsername);
      if (cachedCookies) {
        await this.setCookiesFromArray(cachedCookies);
      }

      // Load last checked tweet ID from cache if no configured ID exists
      if (!this.configuredTweetId) {
        this.lastCheckedTweetId = await getLastCheckedTweetId();
        broadcastUpdate({ type: "lastTweetId", data: this.lastCheckedTweetId });
      } else {
        this.lastCheckedTweetId = this.configuredTweetId;
      }

      // Try to login with retries
      logger.info("Attempting Twitter login...");
      while (true) {
        try {
          await this.client.login(
            this.config.username,
            this.config.password,
            this.config.email,
          );

          if (await this.client.isLoggedIn()) {
            // Cache the new cookies
            const cookies = await this.client.getCookies();
            await cacheCookies(this.config.username, cookies);
            break;
          }
        } catch (error) {
          logger.error("Failed to login to Twitter, retrying...", error);
        }

        // Wait before retrying
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }

      // Initialize admin IDs after successful login (convert from handle to account id)
      await this.initializeAdminIds();

      this.isInitialized = true;
      logger.info("Successfully logged in to Twitter");
    } catch (error) {
      logger.error("Failed to initialize Twitter client:", error);
      throw error;
    }
  }

  private async fetchAllNewMentions(): Promise<Tweet[]> {
    const BATCH_SIZE = 20;
    let allNewTweets: Tweet[] = [];
    let foundOldTweet = false;
    let maxAttempts = 10; // Safety limit to prevent infinite loops
    let attempts = 0;

    while (!foundOldTweet && attempts < maxAttempts) {
      try {
        const batch = (
          await this.client.fetchSearchTweets(
            `@${this.twitterUsername}`,
            BATCH_SIZE,
            SearchMode.Latest,
            allNewTweets.length > 0
              ? allNewTweets[allNewTweets.length - 1].id
              : undefined,
          )
        ).tweets;

        if (batch.length === 0) break; // No more tweets to fetch

        // Check if any tweet in this batch is older than or equal to our last checked ID
        for (const tweet of batch) {
          if (!tweet.id) continue;

          const referenceId = this.configuredTweetId || this.lastCheckedTweetId;
          if (!referenceId || BigInt(tweet.id) > BigInt(referenceId)) {
            allNewTweets.push(tweet);
          } else {
            foundOldTweet = true;
            break;
          }
        }

        if (batch.length < BATCH_SIZE) break; // Last batch was partial, no more to fetch
        attempts++;
      } catch (error) {
        logger.error("Error fetching mentions batch:", error);
        break;
      }
    }

    // Sort all fetched tweets by ID (chronologically)
    return allNewTweets.sort((a, b) => {
      const aId = BigInt(a.id || "0");
      const bId = BigInt(b.id || "0");
      return aId > bId ? 1 : aId < bId ? -1 : 0;
    });
  }

  async startMentionsCheck() {
    logger.info("Listening for mentions...");

    // Check mentions every minute
    this.checkInterval = setInterval(async () => {
      if (!this.isInitialized) return;

      try {
        logger.info("Checking mentions...");

        const newTweets = await this.fetchAllNewMentions();

        if (newTweets.length === 0) {
          logger.info("No new mentions");
        } else {
          logger.info(`Found ${newTweets.length} new mentions`);

          // Process new tweets
          for (const tweet of newTweets) {
            if (!tweet.id) continue;

            try {
              if (this.isSubmission(tweet)) {
                logger.info(
                  `Received new submission: ${this.getTweetLink(tweet.id, tweet.username)}`,
                );
                await this.handleSubmission(tweet);
              } else if (this.isModeration(tweet)) {
                logger.info(
                  `Received new moderation: ${this.getTweetLink(tweet.id, tweet.username)}`,
                );
                await this.handleModeration(tweet);
              }
            } catch (error) {
              logger.error("Error processing tweet:", error);
            }
          }

          // Update the last checked tweet ID to the most recent one
          const latestTweetId = newTweets[newTweets.length - 1].id;
          if (latestTweetId) {
            await this.setLastCheckedTweetId(latestTweetId);
          }
        }
      } catch (error) {
        logger.error("Error checking mentions:", error);
      }
    }, 60000); // Check every minute
  }

  async stop() {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    await this.client.logout();
    this.isInitialized = false;
  }

  private async handleSubmission(tweet: Tweet): Promise<void> {
    const userId = tweet.userId;
    if (!userId || !tweet.id) return;

    try {
      // Get submission count from database
      const dailyCount = db.getDailySubmissionCount(userId);

      if (dailyCount >= this.DAILY_SUBMISSION_LIMIT) {
        await this.replyToTweet(
          tweet.id,
          "You've reached your daily submission limit. Please try again tomorrow.",
        );
        logger.info(`User ${userId} has reached limit, replied to submission.`);
        return;
      }

      // Extract curator handle and command from submission tweet
      const submissionMatch = tweet.text?.match(/(?:!submit\s*@(\w+)|@(\w+)\s*!submit)/i);
      if (!submissionMatch) {
        logger.error(`Invalid submission format in tweet ${tweet.id}`);
        return;
      }

      // The curator handle could be in either capture group depending on the order
      const curatorHandle = submissionMatch[1] || submissionMatch[2];

      // Extract categories from hashtags in submission tweet (excluding command hashtags)
      const categories = (tweet.hashtags || []).filter(
        (tag) => !["submit", "approve", "reject"].includes(tag.toLowerCase()),
      );

      // Extract description: everything that's not the command or hashtags
      const description = tweet.text
        ?.replace(/!submit\s*@\w+/gi, "") // Remove !submit @handle
        ?.replace(/@\w+\s*!submit/gi, "") // Remove @handle !submit
        ?.replace(/#\w+/g, "") // Remove hashtags
        ?.trim() || undefined;

      // Create submission using the tweet's content
      const submission: TwitterSubmission = {
        tweetId: tweet.id!, // The tweet being submitted
        userId: tweet.userId!,
        username: tweet.username!,
        content: tweet.text || "",
        categories: categories,
        description: description || undefined,
        status: "pending",
        moderationHistory: [],
        createdAt:
          tweet.timeParsed?.toISOString() || new Date().toISOString(),
        submittedAt: new Date().toISOString()
      };

      // Save submission to database
      db.saveSubmission(submission);
      // Increment submission count in database
      db.incrementDailySubmissionCount(userId);

      // Send acknowledgment and save its ID
      const acknowledgmentTweetId = await this.replyToTweet(
        tweet.id, // Reply to the submission tweet
        "Successfully submitted!",
      );

      if (acknowledgmentTweetId) {
        db.updateSubmissionAcknowledgment(
          tweet.id!,
          acknowledgmentTweetId,
        );
        logger.info(
          `Successfully submitted. Sent reply: ${this.getTweetLink(acknowledgmentTweetId)}`,
        );
      } else {
        logger.error(
          `Failed to acknowledge submission: ${this.getTweetLink(tweet.id, tweet.username)}`,
        );
      }
    } catch (error) {
      logger.error(`Error handling submission for tweet ${tweet.id}:`, error);
    }
  }

  private async handleModeration(tweet: Tweet): Promise<void> {
    const userId = tweet.userId;
    if (!userId || !tweet.id) return;

    // Verify admin status using cached ID
    if (!this.isAdmin(userId)) {
      logger.info(`User ${userId} is not admin.`);
      return; // Silently ignore non-admin moderation attempts
    }

    // Get the tweet this is in response to (should be our acknowledgment tweet)
    const inReplyToId = tweet.inReplyToStatusId;
    if (!inReplyToId) return;

    // Get submission by acknowledgment tweet ID
    const submission = db.getSubmissionByAcknowledgmentTweetId(inReplyToId);
    if (!submission) return;

    // Check if submission has already been moderated by any admin
    if (submission.status !== "pending") {
      logger.info(
        `Submission ${submission.tweetId} has already been moderated, ignoring new moderation attempt.`,
      );
      return;
    }

    const action = this.getModerationAction(tweet);
    if (!action) return;

    // Add moderation to database
    const adminUsername = this.adminIdCache.get(userId);
    if (!adminUsername) {
      logger.error(`Could not find username for admin ID ${userId}`);
      return;
    }

    // Extract categories from hashtags in moderation tweet (excluding command hashtags)
    const categories = (tweet.hashtags || []).filter(
      (tag) => !["submit", "approve", "reject"].includes(tag.toLowerCase()),
    );

    // Extract note: everything in the tweet that's not a hashtag
    const note = tweet.text
      ?.replace(/#\w+/g, "") // Remove hashtags
      .trim() || undefined;

    const moderation: Moderation = {
      adminId: adminUsername,
      action: action,
      timestamp: tweet.timeParsed || new Date(),
      tweetId: submission.tweetId, // Use the original submission's tweetId
      categories: categories.length > 0 ? categories : undefined,
      note: note
    };
    db.saveModerationAction(moderation);

    // Process the moderation action
    if (action === "approve") {
      logger.info(
        `Received review from Admin ${this.adminIdCache.get(userId)}, processing approval.`,
      );
      await this.processApproval(tweet, submission);
    } else {
      logger.info(
        `Received review from Admin ${this.adminIdCache.get(userId)}, processing rejection.`,
      );
      await this.processRejection(tweet, submission);
    }
  }

  private async processApproval(
    tweet: Tweet,
    submission: TwitterSubmission,
  ): Promise<void> {
    // TODO: Add NEAR integration here for approved submissions
    const responseTweetId = await this.replyToTweet(
      tweet.id!,
      "Your submission has been approved and will be added to the roadmap!",
    );
    if (responseTweetId) {
      db.updateSubmissionStatus(
        submission.tweetId,
        "approved",
        responseTweetId,
      );

      // Handle exports for approved submission
      if (this.exportManager) {
        try {
          await this.exportManager.handleApprovedSubmission(submission);
        } catch (error) {
          logger.error("Failed to handle exports for approved submission:", error);
        }
      }
    }
  }

  private async processRejection(
    tweet: Tweet,
    submission: TwitterSubmission,
  ): Promise<void> {
    // TODO: Add NEAR integration here for rejected submissions
    const responseTweetId = await this.replyToTweet(
      tweet.id!,
      "Your submission has been reviewed and was not accepted for the roadmap at this time.",
    );
    if (responseTweetId) {
      db.updateSubmissionStatus(
        submission.tweetId,
        "rejected",
        responseTweetId,
      );
    }
  }

  private getModerationAction(tweet: Tweet): "approve" | "reject" | null {
    const hashtags = tweet.hashtags?.map((tag) => tag.toLowerCase()) || [];
    if (hashtags.includes("approve")) return "approve";
    if (hashtags.includes("reject")) return "reject";
    return null;
  }

  private isModeration(tweet: Tweet): boolean {
    return this.getModerationAction(tweet) !== null;
  }

  private isSubmission(tweet: Tweet): boolean {
    return tweet.text?.toLowerCase().includes("!submit") || false;
  }

  private async replyToTweet(
    tweetId: string,
    message: string,
  ): Promise<string | null> {
    try {
      const response = await this.client.sendTweet(message, tweetId);
      const responseData = (await response.json()) as any;
      // Extract tweet ID from response
      const replyTweetId =
        responseData?.data?.create_tweet?.tweet_results?.result?.rest_id;
      return replyTweetId || null;
    } catch (error) {
      logger.error("Error replying to tweet:", error);
      return null;
    }
  }

  async setLastCheckedTweetId(tweetId: string) {
    this.configuredTweetId = tweetId;
    this.lastCheckedTweetId = tweetId;
    await saveLastCheckedTweetId(tweetId);
    logger.info(`Last checked tweet ID configured to: ${tweetId}`);
    broadcastUpdate({ type: "lastTweetId", data: tweetId });
  }

  getLastCheckedTweetId(): string | null {
    return this.lastCheckedTweetId;
  }

  private getTweetLink(
    tweetId: string,
    username: string = this.twitterUsername,
  ): string {
    return `https://x.com/${username}/status/${tweetId}`;
  }
}
