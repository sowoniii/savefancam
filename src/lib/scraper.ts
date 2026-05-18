import * as cheerio from "cheerio";

export async function scrapeDcPost(url: string) {
  // Convert to mobile URL for easier parsing if it's desktop
  let targetUrl = url;
  let galleryId = "";
  let no = "";

  try {
    const urlObj = new URL(url);
    if (urlObj.hostname.includes("gall.dcinside.com")) {
      const isMini = urlObj.pathname.includes("/mini/");
      const isMgall = urlObj.pathname.includes("/mgallery/");
      galleryId = urlObj.searchParams.get("id") || "";
      no = urlObj.searchParams.get("no") || "";
      
      let typePrefix = "board";
      if (isMini) typePrefix = "mini";
      if (isMgall) typePrefix = "board/minor";
      
      targetUrl = `https://m.dcinside.com/${typePrefix}/${galleryId}/${no}`;
    } else if (urlObj.hostname.includes("m.dcinside.com")) {
      const parts = urlObj.pathname.split('/').filter(Boolean);
      if (parts.length >= 2) {
        if (parts[0] === 'mini') {
          galleryId = parts[1];
          no = parts[2] || parts[1];
          targetUrl = `https://m.dcinside.com/mini/${galleryId}/${no}`;
        } else if (parts[0] === 'board') {
          if (parts[1] === 'minor' && parts.length >= 4) {
            galleryId = parts[2];
            no = parts[3];
            targetUrl = `https://m.dcinside.com/board/minor/${galleryId}/${no}`;
          } else {
            galleryId = parts[1];
            no = parts[2] || parts[1];
            targetUrl = `https://m.dcinside.com/board/${galleryId}/${no}`;
          }
        }
      }
    }
  } catch (e) {
    throw new Error("Invalid URL format");
  }

  if (!galleryId || !no) {
    throw new Error("Could not extract gallery ID or post number from URL");
  }

  // Fetch HTML
  const response = await fetch(targetUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1",
      "Referer": "https://m.dcinside.com/"
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch post. Status: ${response.status}`);
  }

  const html = await response.text();
  const $ = cheerio.load(html);

  // Parse Metadata (Mobile DC Layout)
  const titleBox = $(".gallview-tit-box .tit");
  if (titleBox.length === 0 || !titleBox.text().trim()) {
    throw new Error("디시인사이드에서 삭제되었거나 존재하지 않는 게시글입니다.");
  }
  
  const is_mobile_written = titleBox.find(".sp-mweb, .sp-app").length > 0;
  
  const titleRaw = titleBox.text().replace(/\s+/g, " ").trim();
  // titleRaw might be "[일반] 개라봉"
  let category = "일반";
  const categoryMatch = titleRaw.match(/^\[(.*?)\]\s*/);
  if (categoryMatch) {
    category = categoryMatch[1];
  }
  const title = titleRaw.replace(/^\[.*?\]\s*/, ''); // Remove category like [일반] if present

  const author = $(".gallview-tit-box .nick").text().trim();
  // Sometimes mobile doesn't show IP directly, or it's in another span.
  const authorIp = ""; // Mobile usually doesn't show it unless we dig into data attributes
  
  // Date is the last li in .ginfo2
  const date = $(".gallview-tit-box .ginfo2 li").last().text().trim();
  
  // Views, Comments, Likes
  // We can just extract all text and regex it since it's grouped together.
  const fullText = $("body").text().replace(/\s+/g, " ");
  
  const viewsMatch = fullText.match(/조회수\s*([\d,]+)/);
  const likesMatch = fullText.match(/추천\s*([\d,]+)/);
  const commentsMatch = fullText.match(/댓글\s*([\d,]+)/);
  
  const views = viewsMatch ? parseInt(viewsMatch[1].replace(/,/g, '')) : 0;
  const likes = likesMatch ? parseInt(likesMatch[1].replace(/,/g, '')) : 0;
  const comments_count = commentsMatch ? parseInt(commentsMatch[1].replace(/,/g, '')) : 0;

  // Content
  let has_video = false;
  const contentArea = $(".thum-txtin");
  
  // Extract images and parse animated formats (data-gif, data-mp4)
  const images: string[] = [];
  contentArea.find("img").each((_, el) => {
    const $el = $(el);
    
    // Always prioritize the real GIF version (data-gif) to keep it as a standard <img> tag
    // as requested by the user. If data-gif is not present, fall back to data-original, data-src, or src.
    const gifUrl = $el.attr("data-gif") || $el.attr("data-original") || $el.attr("data-src") || $el.attr("src");

    if (gifUrl && !gifUrl.includes("dccon_loading")) {
      let absoluteGif = gifUrl;
      if (absoluteGif.startsWith("//")) absoluteGif = "https:" + absoluteGif;
      else if (absoluteGif.startsWith("/")) absoluteGif = "https://m.dcinside.com" + absoluteGif;
      
      images.push(absoluteGif);
      
      const proxyGif = `/api/proxy-image?url=${encodeURIComponent(absoluteGif)}`;
      $el.attr("src", proxyGif);
      $el.attr("loading", "lazy");
      
      // Clean up all DC Inside attributes and lazy classes to ensure immediate browser rendering
      $el.removeAttr("data-gif");
      $el.removeAttr("data-mp4");
      $el.removeAttr("data-original");
      $el.removeAttr("data-src");
      $el.removeClass("lazy");
    }
  });

  // Remove loading images if any
  contentArea.find("img[src*='dccon_loading']").remove();
  
  // Remove lazy class from images to prevent DC CSS from hiding them
  contentArea.find("img.lazy").removeClass("lazy");
  
  // Remove ads, scripts, and unnecessary elements
  contentArea.find("script, iframe, ins, .tx-ad-wrap, .ad_box, .adv, .power_link, .daum_ddn_area").remove();

  // Extract videos (mp4, webm) and proxy them
  contentArea.find("video, source").each((_, el) => {
    // Lazy loaded video sources might use data-src
    let src = $(el).attr("data-src") || $(el).attr("src");
    if (src) {
      has_video = true;
      $(el).attr("src", `/api/proxy-image?url=${encodeURIComponent(src)}`);
      $(el).removeAttr("data-src");
    }
    // Handle poster attribute on video
    if (el.tagName === 'video') {
      let poster = $(el).attr("data-poster") || $(el).attr("poster");
      if (poster) {
        $(el).attr("poster", `/api/proxy-image?url=${encodeURIComponent(poster)}`);
        $(el).removeAttr("data-poster");
      }
    }
  });

  const content_html = contentArea.html() || "";
  const has_image = images.length > 0;

  // Extract comments
  const comments: any[] = [];
  $(".all-comment-lst > li").each((_, el) => {
    const $el = $(el);
    const author = $el.find(".nick").text().trim();
    const ip = $el.find(".ip").text().trim().replace(/[()]/g, '');
    const text = $el.find(".txt").html()?.replace(/<br\s*\/?>/g, '\n').replace(/<[^>]*>?/gm, '').trim() || $el.find(".txt").text().trim();
    const date = $el.find(".date").text().trim();
    const isReply = $el.hasClass("comment-add") || $el.find(".sp-reply").length > 0;
    
    if (author && text) {
      comments.push({ author, ip, text, date, isReply });
    }
  });

  return {
    dc_id: no,
    gallery_id: galleryId,
    category,
    title,
    author,
    author_ip: authorIp || null,
    date,
    views,
    likes,
    comments_count,
    content_html,
    images_json: JSON.stringify(images),
    original_url: url,
    has_image,
    has_video,
    is_mobile_written,
    comments_json: JSON.stringify(comments)
  };
}

export async function scrapeDcGalleryList(galleryId: string, isMini: boolean = true) {
  let typePrefix = isMini ? "mini" : "board";
  const targetUrl = `https://m.dcinside.com/${typePrefix}/${galleryId}`;

  const response = await fetch(targetUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1",
      "Referer": "https://m.dcinside.com/"
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch gallery list. Status: ${response.status}`);
  }

  const html = await response.text();
  const $ = cheerio.load(html);

  const posts: { url: string; dc_id: string }[] = [];

  $('.gall-detail-lst > li').each((_, el) => {
    const link = $(el).find('a.lt').attr('href');
    if (link) {
      let absoluteUrl = link;
      if (absoluteUrl.startsWith('/')) {
        absoluteUrl = `https://m.dcinside.com${absoluteUrl}`;
      }
      
      const parts = absoluteUrl.split('/');
      const dc_id = parts[parts.length - 1];
      if (dc_id && !isNaN(Number(dc_id))) {
        posts.push({ url: absoluteUrl, dc_id });
      }
    }
  });

  return posts;
}
