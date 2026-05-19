import { scrapeDcGalleryList, scrapeDcPost } from "./scraper";
import { dbApi, libsqlClient } from "./db";

let isGeneralScanning = false;
let isLiteratureScanning = false;

/**
 * Common processing engine for both queues.
 * Performs batch DB queries, detects new posts, matches comment count changes, and triggers updates.
 */
async function processPostsList(posts: any[], queueName: string) {
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
  } catch (err: any) {
    console.error(`[${queueName}] DB batch check error:`, err.message);
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
    for (const post of postsToProcess) {
      const isUpdate = dbPostsMap.has(post.dc_id);
      console.log(`[${queueName}] ${isUpdate ? "Updating" : "Archiving"}: ID ${post.dc_id} - ${post.url}`);
      try {
        const postData = await scrapeDcPost(post.url);
        const insertedId = await dbApi.insertPost(postData);
        console.log(`✅ [${queueName}] Successfully ${isUpdate ? "updated" : "archived"} post "${postData.title}" as ID: ${insertedId}`);
        
        // Trigger On-Demand ISR Cache Revalidation (guarantees 0ms page loads with 100% fresh data in production)
        if (process.env.NODE_ENV === "production") {
          try {
            const { revalidatePath } = require("next/cache");
            revalidatePath("/");
            revalidatePath(`/post/${post.dc_id}`);
            console.log(`♻️ [${queueName}] On-Demand ISR Revalidation triggered for / and /post/${post.dc_id}`);
          } catch (isrErr) {
            // Robust silent catch when run from standalone console scripts outside Next.js process context
          }
        }

        // Small delay to prevent rate limits
        await new Promise((resolve) => setTimeout(resolve, 1500));
      } catch (e: any) {
        console.error(`[${queueName}] Failed to process post ${post.url}:`, e.message);
      }
    }
  }
}

// 1. ⚡ Queue 1: General Tab Queue (전체 탭 추적 큐)
// Tracks Page 1 of the main list. Updates on new posts or comment count changes.
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
    const posts = await scrapeDcGalleryList(galleryId, isMini, undefined, 1);
    await processPostsList(posts, "General Queue");
  } catch (error: any) {
    console.error("[General Queue] Error in polling loop:", error.message);
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
  } catch (error: any) {
    console.error("[Literature Queue] Error in polling loop:", error.message);
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
if (typeof global !== 'undefined') {
  if (!(global as any).__autoArchiveStarted) {
    (global as any).__autoArchiveStarted = true;
    startAutoArchive();
  }
}
