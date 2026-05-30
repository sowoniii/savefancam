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
  const postsWithOnlyLikesToUpdate: Array<{ post: GalleryListPost; oldLikes: number }> = [];

  for (const post of posts) {
    if (!dbPostsMap.has(post.dc_id)) {
      // 1. Genuinely brand new post -> Archive! (Must fetch body)
      postsToProcess.push(post);
    } else {
      const dbPost = dbPostsMap.get(post.dc_id)!;
      if (post.comment_count !== dbPost.comments_count) {
        // 2. Comments changed -> Must fetch body to scrape comments!
        postsToProcess.push(post);
      } else if (post.likes > dbPost.likes) {
        // 3. ONLY likes changed -> Do NOT fetch body! Update likes in DB directly!
        postsWithOnlyLikesToUpdate.push({ post, oldLikes: dbPost.likes });
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

  if (postsWithOnlyLikesToUpdate.length > 0) {
    console.log(`[${queueName}] Updating likes directly for ${postsWithOnlyLikesToUpdate.length} existing posts...`);
    for (const item of postsWithOnlyLikesToUpdate) {
      const { post, oldLikes } = item;
      try {
        // 1. Update the database directly
        await libsqlClient.execute({
          sql: "UPDATE posts SET likes = ? WHERE gallery_id = ? AND dc_id = ?",
          args: [post.likes, galleryId, post.dc_id]
        });

        // Invalidate read caches so the new likes count shows up instantly
        dbApi.invalidateCache(post.dc_id);
        console.log(`✅ [${queueName}] Lightweight likes update for post ${post.dc_id}: ${oldLikes} -> ${post.likes}`);

        // 2. Fetch metadata from DB to trigger alerts
        const metaResult = await libsqlClient.execute({
          sql: "SELECT category, title, author FROM posts WHERE gallery_id = ? AND dc_id = ?",
          args: [galleryId, post.dc_id]
        });

        const row = metaResult.rows[0];
        if (row) {
          const category = String(row.category || "일반");
          const title = String(row.title);
          const author = String(row.author);
          
          const isLiterature = category.includes("문학");

          if (isLiterature) {
            // Discord Webhook Milestone Alert
            try {
              const { sendDiscordMilestoneAlert } = await import("./discord");
              const oldMilestone = Math.floor(oldLikes / 10);
              const newMilestone = Math.floor(post.likes / 10);
              if (newMilestone > oldMilestone && newMilestone > 0) {
                const milestone = newMilestone * 10;
                const postData = {
                  dc_id: post.dc_id,
                  title,
                  author,
                  category,
                  likes: post.likes
                };
                await sendDiscordMilestoneAlert(postData as any, oldLikes, milestone);
              }
            } catch (discordErr) {
              console.error(`[${queueName}] Failed to dispatch Discord Webhook:`, errorMessage(discordErr));
            }

            // Web Push Notification Milestone Alert
            try {
              const { sendWebPushNotification } = await import("./web-push");
              const oldMilestone = Math.floor(oldLikes / 10);
              const newMilestone = Math.floor(post.likes / 10);
              if (newMilestone > oldMilestone && newMilestone > 0) {
                const milestone = newMilestone * 10;
                await sendWebPushNotification(
                  `🔥 개추 돌파! (${milestone}개)`,
                  `"${title}" 글이 추천 ${milestone}개를 돌파했습니다!`,
                  `/post/${post.dc_id}`
                );
              }
            } catch (pushErr) {
              console.error(`[${queueName}] Failed to dispatch Web Push:`, errorMessage(pushErr));
            }
          }
        }

        // 3. Trigger On-Demand ISR Cache Revalidation
        if (process.env.NODE_ENV === "production") {
          try {
            const { revalidatePath } = await import("next/cache");
            revalidatePath("/");
            revalidatePath(`/post/${post.dc_id}`);
            console.log(`♻️ [${queueName}] On-Demand ISR Revalidation triggered for / and /post/${post.dc_id}`);
          } catch {
            // Robust silent catch
          }
        }
      } catch (err: unknown) {
        console.error(`[${queueName}] Failed to update likes for post ${post.dc_id}:`, errorMessage(err));
      }
    }
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
// Performs highly optimized scans of the literature list page, leveraging the common processPostsList
// engine to detect updates. This guarantees we only scrape post details (body) when a post is genuinely new
// or when comments have changed. Likes-only changes are updated in the DB directly without scraping.
async function scanLiteratureTab() {
  if (isLiteratureScanning) return;
  isLiteratureScanning = true;

  const galleryId = process.env.AUTO_ARCHIVE_GALLERY_ID || "";
  if (!galleryId) {
    isLiteratureScanning = false;
    return;
  }

  try {
    const litHead = process.env.AUTO_ARCHIVE_LIT_HEAD || "60";
    const isMini = process.env.AUTO_ARCHIVE_IS_MINI !== "false";
    
    console.log(`[Literature Queue] 🔍 Scanning literature tab list (fetching up to 100 posts)...`);
    
    // Robust Hybrid strategy: Fetch page 1 and page 2 in parallel to guarantee we capture 
    // at least 100 posts even if DC Inside mobile ignores list_num=100.
    const [page1, page2] = await Promise.all([
      scrapeDcGalleryList(galleryId, isMini, litHead, 1, 100),
      scrapeDcGalleryList(galleryId, isMini, litHead, 2, 100)
    ]);

    // Merge and deduplicate by dc_id to prevent any redundant sweeps
    const mergedMap = new Map<string, typeof page1[number]>();
    for (const post of [...page1, ...page2]) {
      mergedMap.set(post.dc_id, post);
    }
    
    const uniquePosts = Array.from(mergedMap.values()).slice(0, 100);
    console.log(`[Literature Queue] Deduplicated and finalized ${uniquePosts.length} posts to scan.`);

    await processPostsList(uniquePosts, "Literature Queue");
  } catch (error: unknown) {
    console.error("[Literature Queue] Error in literature polling loop:", errorMessage(error));
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
