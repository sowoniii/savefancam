import { scrapeDcGalleryList, scrapeDcPost } from "./scraper";
import { dbApi, libsqlClient } from "./db";

let isGeneralScanning = false;
let isLiteratureScanning = false;
let generalCycleCount = 0;
let litRoundRobinIndex = 0;

type GalleryListPost = {
  url: string;
  dc_id: string;
  category: string;
  likes: number;
  comment_count: number;
};

const POST_PROCESS_CONCURRENCY = Math.max(1, Number(process.env.AUTO_ARCHIVE_POST_CONCURRENCY || 2));
const POST_SCRAPE_DELAY_MIN_MS = Number(process.env.AUTO_ARCHIVE_POST_DELAY_MIN_MS || 250);
const POST_SCRAPE_DELAY_MAX_MS = Number(process.env.AUTO_ARCHIVE_POST_DELAY_MAX_MS || 800);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const randomDelay = (minMs: number, maxMs: number) => {
  if (maxMs <= minMs) return minMs;
  return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
};

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

async function runWithConcurrency<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      await worker(item);
    }
  });

  await Promise.all(workers);
}

/**
 * Common processing engine for both queues.
 * Performs batch DB queries, detects new posts, matches comment count changes, and triggers updates.
 */
async function processPostsList(posts: GalleryListPost[], queueName: string) {
  if (posts.length === 0) return;

  const dcIds = posts.map(p => p.dc_id);
  const dbPostsMap = new Map<string, { comments_count: number; likes: number }>();
  const galleryId = process.env.AUTO_ARCHIVE_GALLERY_ID || "";

  try {
    const placeholders = dcIds.map(() => "?").join(", ");
    const checkResult = await libsqlClient.execute({
      sql: `SELECT dc_id, comments_count, likes FROM posts WHERE gallery_id = ? AND dc_id IN (${placeholders})`,
      args: [galleryId, ...dcIds]
    });
    for (const row of checkResult.rows) {
      if (row.dc_id !== null && row.dc_id !== undefined) {
        dbPostsMap.set(String(row.dc_id), {
          comments_count: Number(row.comments_count ?? 0),
          likes: Number(row.likes ?? 0)
        });
      }
    }
  } catch (err: unknown) {
    console.error(`[${queueName}] DB batch check error:`, errorMessage(err));
    return;
  }

  const postsToProcess: typeof posts = [];
  for (const post of posts) {
    if (!dbPostsMap.has(post.dc_id)) {
      // 1. Genuinely brand new post -> Archive!
      postsToProcess.push(post);
    } else {
      // 2. Existing post -> Update if comment count changes OR likes count on list page is strictly greater!
      const dbPost = dbPostsMap.get(post.dc_id)!;
      if (post.comment_count !== dbPost.comments_count || post.likes > dbPost.likes) {
        console.log(`🔥 [${queueName}] Post ${post.dc_id} has new updates! Comments DB: ${dbPost.comments_count} -> List: ${post.comment_count} | Likes DB: ${dbPost.likes} -> List: ${post.likes}`);
        postsToProcess.push(post);
      }
    }
  }

  if (postsToProcess.length > 0) {
    console.log(`[${queueName}] Processing ${postsToProcess.length} posts...`);
    // Process oldest posts first (ordered chronologically)
    postsToProcess.reverse();
    await runWithConcurrency(postsToProcess, POST_PROCESS_CONCURRENCY, async (post) => {
      const isUpdate = dbPostsMap.has(post.dc_id);
      console.log(`[${queueName}] ${isUpdate ? "Updating" : "Archiving"}: ID ${post.dc_id} - ${post.url}`);
      try {
        const postData = await scrapeDcPost(post.url);
        
        // 🔔 Keep the old likes value for milestone check before insertPost overwrites it!
        const oldLikes = isUpdate ? (dbPostsMap.get(post.dc_id)?.likes ?? 0) : 0;
        
        const insertedId = await dbApi.insertPost(postData);
        console.log(`✅ [${queueName}] Successfully ${isUpdate ? "updated" : "archived"} post "${postData.title}" as ID: ${insertedId}`);
        
        // 🔔 Discord Webhook Trigger for Literature Posts
        const isLiterature = postData.category?.includes("문학") || post.category?.includes("문학");
        if (isLiterature) {
          try {
            const { sendDiscordNewPostAlert, sendDiscordMilestoneAlert } = await import("./discord");
            if (!isUpdate) {
              // Genuinely new literature post archived!
              await sendDiscordNewPostAlert(postData);
            } else {
              // Check 10, 20, 30 milestone likes
              const oldMilestone = Math.floor(oldLikes / 10);
              const newMilestone = Math.floor(postData.likes / 10);
              if (newMilestone > oldMilestone && newMilestone > 0) {
                const milestone = newMilestone * 10;
                await sendDiscordMilestoneAlert(postData, oldLikes, milestone);
              }
            }
          } catch (discordErr) {
            console.error(`[${queueName}] Failed to dispatch Discord Webhook:`, errorMessage(discordErr));
          }
        }

        // 🔔 Web Push Notification Trigger (Literature Posts Only)
        if (isLiterature) {
          try {
            const { sendWebPushNotification } = await import("./web-push");
            if (!isUpdate) {
              // Genuinely new post archived!
              await sendWebPushNotification(
                "🔔 아카이브 신규 등록!",
                `[${postData.category || '일반'}] ${postData.title} (${postData.author})`,
                `/post/${postData.dc_id}`
              );
            } else {
              // Check milestone likes (개추 알림)
              const oldMilestone = Math.floor(oldLikes / 10);
              const newMilestone = Math.floor(postData.likes / 10);
              if (newMilestone > oldMilestone && newMilestone > 0) {
                const milestone = newMilestone * 10;
                await sendWebPushNotification(
                  `🔥 개추 돌파! (${milestone}개)`,
                  `"${postData.title}" 글이 추천 ${milestone}개를 돌파했습니다!`,
                  `/post/${postData.dc_id}`
                );
              }
            }
          } catch (pushErr) {
            console.error(`[${queueName}] Failed to dispatch Web Push:`, errorMessage(pushErr));
          }
        }
        
        // Trigger On-Demand ISR Cache Revalidation (guarantees 0ms page loads with 100% fresh data in production)
        if (process.env.NODE_ENV === "production") {
          try {
            const { revalidatePath } = await import("next/cache");
            revalidatePath("/");
            revalidatePath(`/post/${post.dc_id}`);
            console.log(`♻️ [${queueName}] On-Demand ISR Revalidation triggered for / and /post/${post.dc_id}`);
          } catch {
            // Robust silent catch when run from standalone console scripts outside Next.js process context
          }
        }

        await sleep(randomDelay(POST_SCRAPE_DELAY_MIN_MS, POST_SCRAPE_DELAY_MAX_MS));
      } catch (e: unknown) {
        console.error(`[${queueName}] Failed to process post ${post.url}:`, errorMessage(e));
      }
    });
  }
}

// (Literature Queue custom round-robin checks are now integrated directly inside scanLiteratureTab to be 100% database-driven and robust against invalid headids)

// 1. ⚡ Queue 1: General Tab Queue (전체 탭 추적 큐)
// Tracks Page 1-3 of the main list on a smart cycle (Page 1 every 3s, Page 2 every 10 cycles, Page 3 every 20 cycles).
async function scanGeneralTab() {
  if (isGeneralScanning) return;
  isGeneralScanning = true;

  const galleryId = process.env.AUTO_ARCHIVE_GALLERY_ID || "";
  const isMini = process.env.AUTO_ARCHIVE_IS_MINI !== "false";

  if (!galleryId) {
    isGeneralScanning = false;
    return;
  }

  try {
    generalCycleCount++;
    let pageToScrape = 1;

    // Smart cycle allocation: Page 3 every 20 cycles (~60s), Page 2 every 10 cycles (~30s), Page 1 on all other cycles
    if (generalCycleCount % 20 === 0) {
      pageToScrape = 3;
      console.log(`[General Queue] 🔍 Slow-sweep Page 3 triggered to catch older posts...`);
    } else if (generalCycleCount % 10 === 0) {
      pageToScrape = 2;
      console.log(`[General Queue] 🔍 Slow-sweep Page 2 triggered to catch older posts...`);
    }

    const posts = await scrapeDcGalleryList(galleryId, isMini, undefined, pageToScrape);
    await processPostsList(posts, `General Queue (P${pageToScrape})`);
  } catch (error: unknown) {
    console.error("[General Queue] Error in polling loop:", errorMessage(error));
  } finally {
    isGeneralScanning = false;
  }
}

// 2. ⚡ Queue 2: Literature Tab Queue (문학 탭 추적 큐)
// Performs live database-driven round-robin active checking for archived literature posts,
// bypassing both CDN caching and missing custom gallery category tabs.
async function scanLiteratureTab() {
  if (isLiteratureScanning) return;
  isLiteratureScanning = true;

  const galleryId = process.env.AUTO_ARCHIVE_GALLERY_ID || "";
  if (!galleryId) {
    isLiteratureScanning = false;
    return;
  }

  try {
    // 1. Perform a safe parallel active fetch of the top 5 latest literature posts directly.
    // Since 99% of active view, comment, and recommendation (개추) updates happen on the latest 5 posts,
    // scanning all 5 in parallel on every cycle ensures virtually instant updates (within 4-5 seconds)
    // instead of the slow 2-minute round-robin lag.
    const activeResult = await libsqlClient.execute({
      sql: `SELECT dc_id, original_url, comments_count, likes, title FROM posts WHERE gallery_id = ? AND category LIKE '%문학%' ORDER BY id DESC LIMIT 5`,
      args: [galleryId]
    });

    const activePosts = activeResult.rows.map(row => ({
      dc_id: String(row.dc_id),
      url: String(row.original_url),
      comments_count: Number(row.comments_count ?? 0),
      likes: Number(row.likes ?? 0),
      title: String(row.title)
    }));

    if (activePosts.length > 0) {
      console.log(`🔍 [Literature Active Scan] Checking top ${activePosts.length} latest active literature posts...`);
      
      const promises = activePosts.map(async (postToCheck) => {
        try {
          const postData = await scrapeDcPost(postToCheck.url);
          
          if (postData.comments_count !== postToCheck.comments_count || postData.likes !== postToCheck.likes) {
            console.log(`🔥 [Literature Queue] Post ${postToCheck.dc_id} has updates! Comments DB: ${postToCheck.comments_count} -> Live: ${postData.comments_count} | Likes DB: ${postToCheck.likes} -> Live: ${postData.likes}`);
            
            const oldLikes = postToCheck.likes;
            const insertedId = await dbApi.insertPost(postData);
            console.log(`✅ [Literature Queue] Successfully updated post "${postData.title}" as ID: ${insertedId}`);

            // Trigger Discord Webhook Milestone Alert if likes changed
            try {
              const { sendDiscordMilestoneAlert } = await import("./discord");
              const oldMilestone = Math.floor(oldLikes / 10);
              const newMilestone = Math.floor(postData.likes / 10);
              if (newMilestone > oldMilestone && newMilestone > 0) {
                const milestone = newMilestone * 10;
                await sendDiscordMilestoneAlert(postData, oldLikes, milestone);
              }
            } catch (discordErr) {
              console.error(`[Literature Queue] Failed to dispatch Discord Webhook:`, errorMessage(discordErr));
            }

            // Trigger Web Push Milestone Alert if likes changed
            try {
              const { sendWebPushNotification } = await import("./web-push");
              const oldMilestone = Math.floor(oldLikes / 10);
              const newMilestone = Math.floor(postData.likes / 10);
              if (newMilestone > oldMilestone && newMilestone > 0) {
                const milestone = newMilestone * 10;
                await sendWebPushNotification(
                  `🔥 개추 돌파! (${milestone}개)`,
                  `"${postData.title}" 글이 추천 ${milestone}개를 돌파했습니다!`,
                  `/post/${postData.dc_id}`
                );
              }
            } catch (pushErr) {
              console.error(`[Literature Queue] Failed to dispatch Web Push:`, errorMessage(pushErr));
            }

            // ISR Revalidation
            if (process.env.NODE_ENV === "production") {
              try {
                const { revalidatePath } = await import("next/cache");
                revalidatePath("/");
                revalidatePath(`/post/${postToCheck.dc_id}`);
              } catch {}
            }
          }
        } catch (e: unknown) {
          console.error(`[Literature Queue] Failed to update post ${postToCheck.url}:`, errorMessage(e));
        }
      });

      await Promise.all(promises);
    }

    // 2. Also try to catch any brand new literature posts from the list page (if the list tab is valid)
    const litHead = process.env.AUTO_ARCHIVE_LIT_HEAD || "60";
    const isMini = process.env.AUTO_ARCHIVE_IS_MINI !== "false";
    try {
      const posts = await scrapeDcGalleryList(galleryId, isMini, litHead, 1);
      if (posts.length > 0) {
        const dcIds = posts.map(p => p.dc_id);
        const placeholders = dcIds.map(() => "?").join(", ");
        const checkResult = await libsqlClient.execute({
          sql: `SELECT dc_id FROM posts WHERE gallery_id = ? AND dc_id IN (${placeholders})`,
          args: [galleryId, ...dcIds]
        });
        const existingIds = new Set(checkResult.rows.map(r => String(r.dc_id)));
        const newPosts = posts.filter(p => !existingIds.has(p.dc_id));

        if (newPosts.length > 0) {
          console.log(`[Literature Queue] Found ${newPosts.length} new posts via list page...`);
          newPosts.reverse();
          await runWithConcurrency(newPosts, POST_PROCESS_CONCURRENCY, async (post) => {
            console.log(`[Literature Queue] Archiving: ID ${post.dc_id} - ${post.url}`);
            try {
              const postData = await scrapeDcPost(post.url);
              const insertedId = await dbApi.insertPost(postData);
              console.log(`✅ [Literature Queue] Successfully archived new post "${postData.title}" as ID: ${insertedId}`);
              
              try {
                const { sendDiscordNewPostAlert } = await import("./discord");
                await sendDiscordNewPostAlert(postData);
              } catch (discordErr) {
                console.error(`[Literature Queue] Failed to dispatch Discord Webhook:`, errorMessage(discordErr));
              }

              // Trigger Web Push New Post Alert
              try {
                const { sendWebPushNotification } = await import("./web-push");
                await sendWebPushNotification(
                  "🔔 아카이브 신규 등록!",
                  `[${postData.category || '일반'}] ${postData.title} (${postData.author})`,
                  `/post/${postData.dc_id}`
                );
              } catch (pushErr) {
                console.error(`[Literature Queue] Failed to dispatch Web Push:`, errorMessage(pushErr));
              }

              if (process.env.NODE_ENV === "production") {
                try {
                  const { revalidatePath } = await import("next/cache");
                  revalidatePath("/");
                  revalidatePath(`/post/${post.dc_id}`);
                } catch {}
              }
              await sleep(randomDelay(POST_SCRAPE_DELAY_MIN_MS, POST_SCRAPE_DELAY_MAX_MS));
            } catch (e: unknown) {
              console.error(`[Literature Queue] Failed to process post ${post.url}:`, errorMessage(e));
            }
          });
        }
      }
    } catch (listErr) {
      // Quietly ignore list page errors if the gallery does not have a custom tab
    }
  } catch (error: unknown) {
    console.error("[Literature Queue] Error in polling loop:", errorMessage(error));
  } finally {
    isLiteratureScanning = false;
  }
}

// 3. Schedulers with Humanized Jitter
function scheduleNextGeneralScan() {
  const baseInterval = Number(process.env.AUTO_ARCHIVE_INTERVAL_SEC) || 3;
  const jitter = baseInterval <= 5 ? (1000 + Math.random() * 2000) : 0;
  const nextDelay = (baseInterval * 1000) + jitter;

  setTimeout(async () => {
    await scanGeneralTab();
    scheduleNextGeneralScan();
  }, nextDelay);
}

function scheduleNextLiteratureScan() {
  const baseInterval = Number(process.env.AUTO_ARCHIVE_INTERVAL_SEC) || 3;
  const jitter = baseInterval <= 5 ? (1000 + Math.random() * 2000) : 0;
  const nextDelay = (baseInterval * 1000) + jitter;

  setTimeout(async () => {
    await scanLiteratureTab();
    scheduleNextLiteratureScan();
  }, nextDelay);
}

// 4. Bootstrapper
export function startAutoArchive() {
  // In local development mode, disable the automatic background crawler by default
  // to prevent dev-server compile-loops and Tokyo DB connection congestion.
  if (process.env.NODE_ENV !== 'production' && process.env.ENABLE_LOCAL_CRAWLER !== 'true') {
    console.log("ℹ️ [Auto Archive] Background crawler disabled in local development to keep responses snappy (ENABLE_LOCAL_CRAWLER !== true).");
    return;
  }

  // Block starting during production build or within static generation workers
  if (
    process.env.NEXT_PHASE === 'phase-production-build' ||
    process.env.NEXT_PRIVATE_WORKER === 'true' ||
    process.env.IS_BUILD === 'true'
  ) {
    return;
  }

  const galleryId = process.env.AUTO_ARCHIVE_GALLERY_ID || "";
  if (!galleryId) return;

  const interval = Number(process.env.AUTO_ARCHIVE_INTERVAL_SEC) || 3;
  console.log(`🟢 [Auto Archive] Booted Dual 3-Second Queues for "${galleryId}":`);
  console.log(`   - ⚡ Queue 1 (General Tab): Page 1 scan at ${interval}s (+ human jitter)`);
  console.log(`   - ⚡ Queue 2 (Literature Tab): Page 1 scan at ${interval}s (+ human jitter)`);

  setTimeout(() => {
    // Perform initial scans
    scanGeneralTab();
    scanLiteratureTab();

    // Start scheduling loops
    scheduleNextGeneralScan();
    scheduleNextLiteratureScan();
  }, 2000);
}

// Next.js hot reloading checker
const autoArchiveGlobal = globalThis as typeof globalThis & { __autoArchiveStarted?: boolean };
if (typeof global !== 'undefined') {
  if (!autoArchiveGlobal.__autoArchiveStarted) {
    autoArchiveGlobal.__autoArchiveStarted = true;
    startAutoArchive();
  }
}
