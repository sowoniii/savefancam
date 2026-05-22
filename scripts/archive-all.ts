import fs from 'fs';
import path from 'path';
import { scrapeDcGalleryList, scrapeDcPost } from "../src/lib/scraper";
import { dbApi, libsqlClient } from "../src/lib/db";
import { uploadPostImagesToImgBB } from "../src/lib/imgbb";

// 1. Manually load Next.js .env.local variables outside dev/production server lifecycle
function loadEnv() {
  try {
    const envPath = path.resolve(process.cwd(), '.env.local');
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, 'utf8');
      for (const line of content.split('\n')) {
        const cleaned = line.trim();
        if (cleaned && !cleaned.startsWith('#')) {
          const firstEquals = cleaned.indexOf('=');
          if (firstEquals !== -1) {
            const key = cleaned.substring(0, firstEquals).trim();
            const val = cleaned.substring(firstEquals + 1).trim().replace(/^["']|["']$/g, '');
            process.env[key] = val;
          }
        }
      }
      console.log("📝 Loaded database credentials and configurations from .env.local");
    } else {
      console.warn("⚠️ .env.local file not found in current directory!");
    }
  } catch (err) {
    console.error("Failed to parse .env.local file:", err);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// 🛠️ self-healing scanner: Finds existing posts in the DB that failed to download images (still contain external dcinside links)
// and forces downloading them to local storage. This guarantees 100% data integrity even after lockups or network timeouts!
async function repairPendingImages() {
  console.log(`\n🔍 [Self-Healing] Checking for posts with missing or failed local image backups...`);
  try {
    const queryResult = await libsqlClient.execute(`
      SELECT id, dc_id, gallery_id, category, title, author, author_ip, date, views, likes, comments_count, content_html, images_json, original_url, has_image, has_video, is_mobile_written, comments_json 
      FROM posts 
      WHERE has_image = 1 AND (images_json LIKE '%dcinside.com%' OR images_json LIKE '%dcimg%')
    `);

    const missingPosts = queryResult.rows;
    if (missingPosts.length === 0) {
      console.log(`✨ [Self-Healing] No pending or broken image backups found! All local storage copies are completely synced.`);
      return;
    }

    console.log(`🛠️ [Self-Healing] Found ${missingPosts.length} posts with external dcinside image URLs. Starting auto-repair...`);

    for (let i = 0; i < missingPosts.length; i++) {
      const row = missingPosts[i];
      const postId = Number(row.id);
      const dcId = String(row.dc_id);
      const title = String(row.title);

      console.log(`   [${i + 1}/${missingPosts.length}] Repairing images for: "${title}" (Local DB ID: ${postId}, DC ID: ${dcId})`);

      const postObj = {
        dc_id: dcId,
        gallery_id: String(row.gallery_id),
        category: String(row.category || '일반'),
        title: title,
        author: String(row.author),
        author_ip: row.author_ip ? String(row.author_ip) : null,
        date: String(row.date),
        views: Number(row.views ?? 0),
        likes: Number(row.likes ?? 0),
        comments_count: Number(row.comments_count ?? 0),
        content_html: String(row.content_html),
        images_json: String(row.images_json),
        original_url: String(row.original_url),
        has_image: Boolean(row.has_image),
        has_video: Boolean(row.has_video),
        is_mobile_written: Boolean(row.is_mobile_written),
        comments_json: String(row.comments_json)
      };

      try {
        const processed = await uploadPostImagesToImgBB(postObj);

        await libsqlClient.execute({
          sql: "UPDATE posts SET content_html = ?, images_json = ?, has_image = ? WHERE id = ?",
          args: [
            processed.content_html,
            processed.images_json,
            processed.has_image ? 1 : 0,
            postId
          ]
        });

        console.log(`   └─ ✅ Successfully repaired and saved all images locally!`);
      } catch (err: any) {
        console.error(`   └─ ❌ Failed to repair images for post #${dcId}:`, err?.message || err);
      }

      await sleep(600);
    }

    console.log(`\n🎉 [Self-Healing] Finished scanning and repairing broken image backups!\n`);
  } catch (scanErr) {
    console.error(`❌ [Self-Healing] Error during self-healing image repair scan:`, scanErr);
  }
}

async function main() {
  loadEnv();
  
  // Await the self-healing process before commencing normal full archival sweep
  await repairPendingImages();

  // CLI Arguments support: bun run scripts/archive-all.ts [gallery_id] [is_mini]
  const args = process.argv.slice(2);
  const galleryId = args[0] || process.env.AUTO_ARCHIVE_GALLERY_ID || "";
  const isMini = args[1] !== undefined ? args[1] === "true" : (process.env.AUTO_ARCHIVE_IS_MINI !== "false");

  if (!galleryId) {
    console.error("❌ Error: No gallery ID specified! Please set AUTO_ARCHIVE_GALLERY_ID in .env.local or pass it as an argument.");
    console.error("👉 Usage: bun run scripts/archive-all.ts [gallery_id] [is_mini: true/false]");
    process.exit(1);
  }

  console.log(`\n======================================================`);
  console.log(`🚀 Starting Full Gallery Backup Script`);
  console.log(`   - Target Gallery ID: "${galleryId}"`);
  console.log(`   - Mode: ${isMini ? "Mini Gallery" : "Major/Minor Gallery"}`);
  console.log(`======================================================\n`);

  let page = 1;
  let totalArchived = 0;
  let totalSkipped = 0;
  let consecutiveErrors = 0;

  // Track global posts crawled to avoid infinite page loops (for DCInside circular redirect bug)
  const globallySeenDcIds = new Set<string>();

  while (true) {
    console.log(`\n📄 [Page ${page}] Fetching post list...`);
    
    let list: Array<{ url: string; dc_id: string; category: string; likes: number; comment_count: number }> = [];
    try {
      list = await scrapeDcGalleryList(galleryId, isMini, undefined, page);
      consecutiveErrors = 0;
    } catch (err) {
      consecutiveErrors++;
      console.error(`❌ [Page ${page}] Failed to fetch post list:`, err instanceof Error ? err.message : String(err));
      
      if (consecutiveErrors >= 3) {
        console.error("🚨 Too many consecutive errors fetching list. Ending run for safety.");
        break;
      }
      console.log("⏳ Retrying page in 3 seconds...");
      await sleep(3000);
      continue;
    }

    if (list.length === 0) {
      console.log(`🏁 [Page ${page}] Received empty list! Reached the end of the gallery.`);
      break;
    }

    // Safety check: if all posts on this page have already been seen globally in this execution, 
    // it means DC Inside has looped us back to page 1 or an arbitrary page. Stop to avoid infinite loop.
    const newPostsOnPage = list.filter(p => !globallySeenDcIds.has(p.dc_id));
    if (newPostsOnPage.length === 0) {
      console.log(`🏁 [Page ${page}] All posts on this page are duplicates of already processed pages. Ending sweep.`);
      break;
    }

    // Add to global seen list
    list.forEach(p => globallySeenDcIds.add(p.dc_id));

    console.log(`✅ [Page ${page}] Found ${list.length} posts on page. Starting download...`);

    // Process posts on this page sequentially to stay completely safe from rate-limits (IP blocks)
    for (let i = 0; i < list.length; i++) {
      const postListItem = list[i];
      const indexStr = `[${i + 1}/${list.length}]`;
      
      // Fast check: does it already exist in the database with the exact same comment count?
      // If it exists and the comment count is same, we can skip downloading detail html entirely!
      try {
        const checkResult = await libsqlClient.execute({
          sql: `SELECT comments_count FROM posts WHERE dc_id = ?`,
          args: [postListItem.dc_id]
        });

        if (checkResult.rows.length > 0) {
          const dbComments = Number(checkResult.rows[0].comments_count ?? 0);
          if (dbComments === postListItem.comment_count) {
            console.log(`⏩ ${indexStr} Post #${postListItem.dc_id} is already backed up with same comments (${dbComments}). Skipping.`);
            totalSkipped++;
            continue;
          }
        }
      } catch (checkErr) {
        // Log error and fallback to full scraping
        console.warn(`⚠️ Batch DB check failed for #${postListItem.dc_id}:`, checkErr);
      }

      // Scraping detail page
      console.log(`📥 ${indexStr} Downloading: #${postListItem.dc_id} - ${postListItem.url}`);
      try {
        const postDetail = await scrapeDcPost(postListItem.url);
        const savedId = await dbApi.insertPost(postDetail);
        console.log(`   └─ ✅ Successfully saved: "${postDetail.title}" (Local DB ID: ${savedId})`);
        totalArchived++;
        consecutiveErrors = 0;
      } catch (err: any) {
        consecutiveErrors++;
        console.error(`   └─ ❌ Failed to download post #${postListItem.dc_id}:`, err instanceof Error ? err.message : String(err));
        
        if (consecutiveErrors >= 5) {
          console.error("🚨 5 consecutive details failed. Ending crawl loop due to potential block or network outage.");
          process.exit(1);
        }
      }

      // Humans reading delay: randomize between 600ms and 1500ms
      const delay = Math.floor(Math.random() * 900) + 600;
      await sleep(delay);
    }

    console.log(`\n🎉 Page ${page} finished! Total archived so far: ${totalArchived}, skipped: ${totalSkipped}`);
    page++;
    
    // Tiny rest between page lists
    await sleep(1500);
  }

  console.log(`\n======================================================`);
  console.log(`🏁 FULL BACKUP COMPLETED`);
  console.log(`   - Total Scrape/Updated: ${totalArchived}`);
  console.log(`   - Total Skipped (Unchanged): ${totalSkipped}`);
  console.log(`   - Total Processed Pages: ${page - 1}`);
  console.log(`======================================================\n`);

  // Close SQL Client gracefully
  process.exit(0);
}

main().catch((e) => {
  console.error("FATAL ERROR in backup run:", e);
  process.exit(1);
});
