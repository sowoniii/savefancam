import { scrapeDcGalleryList } from "../src/lib/scraper";

async function test() {
  const galleryId = "fangall";
  console.log("Fetching main list:");
  const mainPosts = await scrapeDcGalleryList(galleryId, true);
  console.log("Main list count:", mainPosts.length);

  console.log("\nFetching literature list with headid=40:");
  try {
    const litPosts = await scrapeDcGalleryList(galleryId, true, "40", 1);
    console.log("Literature list count:", litPosts.length);
    if (litPosts.length > 0) {
      console.log("First filtered post detail:", JSON.stringify(litPosts[0], null, 2));
      console.log("\nLast filtered post detail:");
      console.log(JSON.stringify(litPosts[litPosts.length - 1], null, 2));
    }
  } catch (e: any) {
    console.error("Lit fetch failed:", e.message);
  }
}

test();
