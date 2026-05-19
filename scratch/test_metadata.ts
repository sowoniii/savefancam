import * as cheerio from "cheerio";

async function test() {
  const url = "https://m.dcinside.com/mini/fangall/1";
  console.log("Fetching url:", url);
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
      }
    });
    const html = await res.text();
    const $ = cheerio.load(html);
    
    console.log("Metadata container HTML:");
    console.log($(".gallview-tit-box").html()?.trim() || "Not found");
    
    console.log("\nginfo2 li text content:");
    $(".ginfo2 li, .gallview-tit-box li").each((i, el) => {
      console.log(`Li ${i}: "${$(el).text().trim()}"`);
    });
  } catch (e: any) {
    console.error("Fetch failed:", e.message);
  }
}

test();
