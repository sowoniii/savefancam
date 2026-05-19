import * as cheerio from "cheerio";

async function run() {
  const url = "https://m.dcinside.com/mini/fangall";
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1",
        "Referer": "https://m.dcinside.com/"
      }
    });
    const html = await res.text();
    const $ = cheerio.load(html);
    
    console.log("=== First 3 List Items HTML ===");
    $(".gall-detail-lst > li").slice(0, 3).each((i, el) => {
      console.log(`--- Item ${i} ---`);
      console.log($(el).html());
    });
  } catch (e: any) {
    console.error("Error:", e.message);
  }
}

run();
