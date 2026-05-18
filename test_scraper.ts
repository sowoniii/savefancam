import { scrapeDcPost } from "./src/lib/scraper";

async function run() {
  try {
    const data = await scrapeDcPost("https://m.dcinside.com/mini/fangall/1");
    console.log(JSON.stringify(data, null, 2));
  } catch (e) {
    console.error(e);
  }
}

run();
