const cheerio = require('cheerio');

async function searchMentionsHtml() {
  const targetUrl = 'https://m.dcinside.com/mini/fangall/420437';
  const response = await fetch(targetUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1",
      "Referer": "https://m.dcinside.com/"
    }
  });
  const html = await response.text();
  const $ = cheerio.load(html);
  
  console.log('Comments with mentions:');
  $('.all-comment-lst > li').each((i, el) => {
    const $el = $(el);
    const hasMention = $el.find('.mention').length > 0;
    if (hasMention) {
      console.log('Found comment with .mention:');
      console.log($.html($el.find('.txt')));
    }
  });
}

searchMentionsHtml();
