const cheerio = require('cheerio');

async function getList() {
  const targetUrl = 'https://m.dcinside.com/mini/fangall';
  const response = await fetch(targetUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1",
      "Referer": "https://m.dcinside.com/"
    }
  });
  const html = await response.text();
  const $ = cheerio.load(html);
  
  console.log('Items:');
  $('.gall-detail-lst > li').each((i, el) => {
    if (i < 10) {
      console.log(`--- Item ${i} ---`);
      console.log('Title:', $(el).find('.subjectin').text().trim());
      console.log('Subject HTML:', $(el).find('.subject-add').html()?.trim());
    }
  });
}

getList();
