import { scrapeDcGalleryList } from "../src/lib/scraper";

async function test() {
  const galleryId = "fangall"; // The target gallery
  console.log("Fetching list for gallery:", galleryId);
  try {
    const posts = await scrapeDcGalleryList(galleryId, true);
    console.log("Total posts parsed:", posts.length);
    console.log("First 5 posts details:");
    for (let i = 0; i < Math.min(5, posts.length); i++) {
      console.log(`Post ${i}:`, JSON.stringify(posts[i], null, 2));
    }
  } catch (e: any) {
    console.error("List fetch failed:", e.message);
  }
}

test();
