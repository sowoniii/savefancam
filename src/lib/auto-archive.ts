import { scrapeDcGalleryList, scrapeDcPost } from "./scraper";
import { dbApi, libsqlClient } from "./db";

let isGeneralScanning = false;
let isLiteratureScanning = false;
let generalCycleCount = 0;

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
  const dbPostsMap = new Map<string, { comments_count: number }>();

  try {
    const placeholders = dcIds.map(() => "?").join(", ");
    const checkResult = await libsqlClient.execute({
      sql: `SELECT dc_id, comments_count FROM posts WHERE dc_id IN (${placeholders})`,
      args: dcIds
    });
    for (const row of checkResult.rows) {
      if (row.dc_id !== null && row.dc_id !== undefined) {
        dbPostsMap.set(String(row.dc_id), {
          comments_count: Number(row.comments_count ?? 0)
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
      // 2. Existing post -> Update if comment count has changed!
      const dbPost = dbPostsMap.get(post.dc_id)!;
      if (post.comment_count !== dbPost.comments_count) {
        console.log(`🔥 [${queueName}] Post ${post.dc_id} has new comments! Comments DB: ${dbPost.comments_count} -> List: ${post.comment_count}`);
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
        const insertedId = await dbApi.insertPost(postData);
        console.log(`✅ [${queueName}] Successfully ${isUpdate ? "updated" : "archived"} post "${postData.title}" as ID: ${insertedId}`);
        
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
// Tracks Page 1 of the literature tab (headid=40). Updates on new literature posts or comment count changes.
async function scanLiteratureTab() {
  if (isLiteratureScanning) return;
  isLiteratureScanning = true;

  const galleryId = process.env.AUTO_ARCHIVE_GALLERY_ID || "";
  const isMini = process.env.AUTO_ARCHIVE_IS_MINI !== "false";
  const litHead = process.env.AUTO_ARCHIVE_LIT_HEAD || "40";

  if (!galleryId) {
    isLiteratureScanning = false;
    return;
  }

  try {
    const posts = await scrapeDcGalleryList(galleryId, isMini, litHead, 1);
    await processPostsList(posts, "Literature Queue");
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
