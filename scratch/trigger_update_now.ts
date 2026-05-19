import { startAutoArchive } from "../src/lib/auto-archive";

console.log("🚀 Manually triggering the auto-archiver cycle once using the new code...");
// We can import the internal check function or just execute the poller.
// Since auto-archive.ts executes on import or we can call startAutoArchive, 
// let's import the specific checkAndArchiveNewPosts function.
import { libsqlClient } from "../src/lib/db";
import { scrapeDcGalleryList, scrapeDcPost } from "../src/lib/scraper";
import { dbApi } from "../src/lib/db";

async function forceUpdateCycle() {
  const galleryId = "fangall";
  const isMini = true;
  console.log(`[Force Poller] Running poll for ${galleryId}...`);

  try {
    const posts = await scrapeDcGalleryList(galleryId, isMini);
    const litHead = process.env.AUTO_ARCHIVE_LIT_HEAD || "40";
    console.log(`[Force Poller] Fetching literature list (pages 1-3) with headid=${litHead}...`);
    
    const litPage1 = await scrapeDcGalleryList(galleryId, isMini, litHead, 1);
    const litPage2 = await scrapeDcGalleryList(galleryId, isMini, litHead, 2).catch(() => []);
    const litPage3 = await scrapeDcGalleryList(galleryId, isMini, litHead, 3).catch(() => []);
    const litPosts = [...litPage1, ...litPage2, ...litPage3];
    
    console.log(`[Force Poller] Main posts: ${posts.length}, Lit posts: ${litPosts.length}`);

    const mergedPostsMap = new Map<string, typeof posts[number] & { isFromLiteratureTab?: boolean }>();
    for (const p of posts) {
      mergedPostsMap.set(p.dc_id, p);
    }
    for (const p of litPosts) {
      mergedPostsMap.set(p.dc_id, { ...p, isFromLiteratureTab: true });
    }

    const allPosts = Array.from(mergedPostsMap.values());
    console.log(`[Force Poller] Total merged posts: ${allPosts.length}`);

    const dcIds = allPosts.map(p => p.dc_id);
    const dbPostsMap = new Map<string, { comments_count: number; likes: number; category: string }>();

    const placeholders = dcIds.map(() => "?").join(", ");
    const checkResult = await libsqlClient.execute({
      sql: `SELECT dc_id, comments_count, likes, category FROM posts WHERE dc_id IN (${placeholders})`,
      args: dcIds
    });
    for (const row of checkResult.rows) {
      if (row.dc_id !== null && row.dc_id !== undefined) {
        dbPostsMap.set(String(row.dc_id), {
          comments_count: Number(row.comments_count ?? 0),
          likes: Number(row.likes ?? 0),
          category: String(row.category ?? "일반")
        });
      }
    }

    const postsToArchive: typeof allPosts = [];
    for (const post of allPosts) {
      if (!dbPostsMap.has(post.dc_id)) {
        postsToArchive.push(post);
      } else {
        const dbPost = dbPostsMap.get(post.dc_id)!;
        const normalizedDbCategory = dbPost.category.replace(/[\[\]]/g, "").trim();
        const normalizedListCategory = post.category.replace(/[\[\]]/g, "").trim();

        const isLiterature = 
          normalizedDbCategory === "문학" || 
          normalizedListCategory === "문학" || 
          post.isFromLiteratureTab === true;

        if (isLiterature) {
          const commentChanged = post.comment_count !== dbPost.comments_count;
          const likesChanged = post.likes !== dbPost.likes;

          if (commentChanged || likesChanged) {
            console.log(`🔥 [Force Poller] Post ${post.dc_id} [문학] has updates! Comments DB: ${dbPost.comments_count} -> List: ${post.comment_count}, Likes DB: ${dbPost.likes} -> List: ${post.likes}`);
            postsToArchive.push(post);
          }
        }
      }
    }

    console.log(`[Force Poller] Found ${postsToArchive.length} posts to update!`);
    for (const post of postsToArchive) {
      console.log(`[Force Poller] Updating post ID ${post.dc_id}...`);
      const postData = await scrapeDcPost(post.url);
      const insertedId = await dbApi.insertPost(postData);
      console.log(`✅ [Force Poller] Successfully updated "${postData.title}" (ID: ${insertedId}). DB Likes is now: ${postData.likes}`);
    }
  } catch (err: any) {
    console.error("Force poller failed:", err.message);
  }
}

forceUpdateCycle();
