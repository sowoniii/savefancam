import { scrapeDcGalleryList, scrapeDcPost } from "./scraper";
import { dbApi, libsqlClient } from "./db";

let isArchiving = false;

export async function checkAndArchiveNewPosts() {
  if (isArchiving) return;
  isArchiving = true;

  const galleryId = process.env.AUTO_ARCHIVE_GALLERY_ID || "";
  const isMini = process.env.AUTO_ARCHIVE_IS_MINI !== "false";

  if (!galleryId) {
    isArchiving = false;
    return;
  }

  console.log(`[Auto Archive] Checking gallery: ${galleryId} (${isMini ? "mini" : "board"})...`);

  try {
    const posts = await scrapeDcGalleryList(galleryId, isMini);
    // Reverse so we process oldest posts first (ordered chronologically)
    posts.reverse();

    for (const post of posts) {
      // Check if it already exists in Turso
      let exists = false;
      try {
        const checkResult = await libsqlClient.execute({
          sql: "SELECT id FROM posts WHERE dc_id = ?",
          args: [post.dc_id]
        });
        exists = checkResult.rows.length > 0;
      } catch (err: any) {
        console.error(`[Auto Archive] DB check error for ${post.dc_id}:`, err.message);
        continue;
      }

      if (!exists) {
        console.log(`[Auto Archive] Found new post! Archiving: ID ${post.dc_id} - ${post.url}`);
        try {
          const postData = await scrapeDcPost(post.url);
          const insertedId = await dbApi.insertPost(postData);
          console.log(`[Auto Archive] Successfully archived post "${postData.title}" as ID: ${insertedId}`);
          
          // Small delay to prevent hitting rate limits
          await new Promise((resolve) => setTimeout(resolve, 2000));
        } catch (e: any) {
          console.error(`[Auto Archive] Failed to archive post ${post.url}:`, e.message);
        }
      }
    }
  } catch (error: any) {
    console.error("[Auto Archive] Error in polling loop:", error.message);
  } finally {
    isArchiving = false;
  }
}

export function startAutoArchive() {
  // 1. Block the auto-archiver from starting during Next.js build phase or inside static generation worker threads
  // to prevent spawning redundant setInterval polling loops that exhaust connections and CPU.
  if (
    process.env.NEXT_PHASE === 'phase-production-build' ||
    process.env.NEXT_PRIVATE_WORKER === 'true' ||
    process.env.IS_BUILD === 'true'
  ) {
    console.log("ℹ️ [Auto Archive] Skipped auto-archiver inside Next.js build or worker thread.");
    return;
  }

  const galleryId = process.env.AUTO_ARCHIVE_GALLERY_ID || "";
  if (!galleryId) {
    console.log("ℹ️ [Auto Archive] No gallery configured. Set AUTO_ARCHIVE_GALLERY_ID to enable auto archiving.");
    return;
  }

  const intervalSec = Number(process.env.AUTO_ARCHIVE_INTERVAL_SEC) || 30;
  console.log(`🟢 [Auto Archive] Starting auto-archiver for "${galleryId}". Interval: ${intervalSec}s`);

  // Run immediately on start (deferred by 1000ms to ensure it runs completely outside of Next.js page render context)
  setTimeout(() => {
    checkAndArchiveNewPosts();
  }, 1000);

  // Run periodically
  setInterval(checkAndArchiveNewPosts, intervalSec * 1000);
}

// Next.js hot reloading global checker to prevent multiple intervals running in dev mode
if (typeof global !== 'undefined') {
  if (!(global as any).__autoArchiveStarted) {
    (global as any).__autoArchiveStarted = true;
    startAutoArchive();
  }
}
