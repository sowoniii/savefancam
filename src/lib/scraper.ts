import * as cheerio from "cheerio";

const SCRAPER_TIMEOUT_MS = Number(process.env.SCRAPER_TIMEOUT_MS || 10000);
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

async function fetchWithRetry(url: string, options: RequestInit = {}, retries = 3, delay = 1000): Promise<Response> {
  const headers = {
    "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1",
    "Referer": "https://m.dcinside.com/",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8",
    "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
    ...options.headers,
  };

  for (let i = 0; i < retries; i++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SCRAPER_TIMEOUT_MS);
    try {
      const res = await fetch(url, { ...options, headers, signal: controller.signal });
      if (res.ok) return res;
      
      // Retry for rate limiting (429) or transient server errors (5xx)
      if (res.status === 429 || res.status >= 500) {
        console.warn(`[Scraper] HTTP error ${res.status} when fetching ${url}. Retrying in ${delay}ms... (Attempt ${i + 1}/${retries})`);
      } else {
        // Return immediately for 403, 404, etc. to avoid unnecessary delay
        return res;
      }
    } catch (err: unknown) {
      if (i === retries - 1) throw err;
      console.warn(`[Scraper] Network error fetching ${url}: ${errorMessage(err)}. Retrying in ${delay}ms... (Attempt ${i + 1}/${retries})`);
    } finally {
      clearTimeout(timeout);
    }
    const jitter = Math.floor(Math.random() * 250);
    await new Promise((resolve) => setTimeout(resolve, delay + jitter));
    delay *= 2; // Exponential backoff
  }
  throw new Error(`Failed to fetch ${url} after ${retries} attempts.`);
}

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
  } catch {
    throw new Error("Invalid URL format");
  }

  if (!galleryId || !no) {
    throw new Error("Could not extract gallery ID or post number from URL");
  }

  // Fetch HTML
  const response = await fetchWithRetry(targetUrl, {});

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
  // Extract reliably from .ginfo2 container to avoid matching random user content in post body
  const viewsText = $(".ginfo2 li").filter((_, li) => $(li).text().includes("조회수")).text();
  const viewsMatch = viewsText.match(/\d+/);
  const views = viewsMatch ? parseInt(viewsMatch[0], 10) : 0;

  const likesText = $(".ginfo2 li").filter((_, li) => $(li).text().includes("추천")).text();
  const likesMatch = likesText.match(/\d+/);
  const likes = likesMatch ? parseInt(likesMatch[0], 10) : 0;

  const commentsText = $(".ginfo2 li").filter((_, li) => $(li).text().includes("댓글")).text();
  const commentsMatch = commentsText.match(/\d+/);
  const comments_count = commentsMatch ? parseInt(commentsMatch[0], 10) : 0;

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
    const src = $(el).attr("data-src") || $(el).attr("src");
    if (src) {
      has_video = true;
      $(el).attr("src", `/api/proxy-image?url=${encodeURIComponent(src)}`);
      $(el).removeAttr("data-src");
    }
    // Handle poster attribute on video
    if (el.tagName === 'video') {
      const poster = $(el).attr("data-poster") || $(el).attr("poster");
      if (poster) {
        $(el).attr("poster", `/api/proxy-image?url=${encodeURIComponent(poster)}`);
        $(el).removeAttr("data-poster");
      }
    }
  });

  const content_html = contentArea.html() || "";
  const has_image = images.length > 0;

  // Extract comments
  const comments: { author: string; ip: string; text: string; date: string; isReply: boolean }[] = [];
  $(".all-comment-lst > li").each((_, el) => {
    const $el = $(el);
    const author = $el.find(".nick").text().trim();
    const ip = $el.find(".ip").text().trim().replace(/[()]/g, '');
    const date = $el.find(".date").text().trim();
    const isReply = $el.hasClass("comment-add") || $el.find(".sp-reply").length > 0;
    
    const $txt = $el.find(".txt");
    const $dccon = $txt.find("img");

    let text = "";
    if ($dccon.length > 0) {
      // It's a DCcon comment
      const src = $dccon.attr("data-gif") || $dccon.attr("data-original") || $dccon.attr("src") || "";
      if (src) {
        let absoluteSrc = src;
        if (absoluteSrc.startsWith("//")) {
          absoluteSrc = "https:" + absoluteSrc;
        } else if (absoluteSrc.startsWith("/")) {
          absoluteSrc = "https://m.dcinside.com" + absoluteSrc;
        }
        text = `[dccon:${absoluteSrc}]`;
      }
    } else {
      // It's a regular text comment
      text = $txt.html()?.replace(/<br\s*\/?>/g, '\n').replace(/<[^>]*>?/gm, '').trim() || $txt.text().trim();
    }

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

export async function scrapeDcGalleryList(galleryId: string, isMini: boolean = true, searchHead?: string, page: number = 1, listNum: number = 100) {
  const typePrefix = isMini ? "mini" : "board";
  let targetUrl = `https://m.dcinside.com/${typePrefix}/${galleryId}`;
  
  const queryParams = new URLSearchParams();
  if (searchHead) {
    if (isMini) {
      queryParams.set("headid", searchHead);
    } else {
      queryParams.set("headid", searchHead);
      queryParams.set("headart", searchHead);
    }
  }
  if (page > 1) {
    queryParams.set("page", String(page));
  }
  if (listNum > 0) {
    queryParams.set("list_num", String(listNum));
  }
  
  const queryStr = queryParams.toString();
  if (queryStr) {
    targetUrl += `?${queryStr}`;
  }

  const response = await fetchWithRetry(targetUrl, {});

  if (!response.ok) {
    throw new Error(`Failed to fetch gallery list. Status: ${response.status}`);
  }

  const html = await response.text();
  const $ = cheerio.load(html);

  const posts: { url: string; dc_id: string; category: string; likes: number; comment_count: number }[] = [];

  $('.gall-detail-lst > li').each((_, el) => {
    const link = $(el).find('a.lt').attr('href');
    if (link) {
      let absoluteUrl = link;
      if (absoluteUrl.startsWith('/')) {
        absoluteUrl = `https://m.dcinside.com${absoluteUrl}`;
      }
      
      try {
        const urlObj = new URL(absoluteUrl, "https://m.dcinside.com");
        const cleanPath = urlObj.pathname;
        const parts = cleanPath.split('/').filter(Boolean);
        const dc_id = parts[parts.length - 1];
        
        // Extract category from first li in ul.ginfo
        const category = $(el).find('ul.ginfo li').first().text().trim() || "일반";

        // Extract recommended count (likes) in a robust way
        const likesText = $(el).find('ul.ginfo li').filter((_, li) => $(li).text().includes("추천")).text();
        const likesMatch = likesText.match(/\d+/);
        const likes = likesMatch ? parseInt(likesMatch[0], 10) : 0;

        // Extract comment count from the right side comment icon anchor link's inner text
        const ctText = $(el).find('a.rt span.ct').text().trim();
        const comment_count = ctText ? parseInt(ctText, 10) : 0;

        if (dc_id && !isNaN(Number(dc_id))) {
          posts.push({ 
            url: absoluteUrl, 
            dc_id, 
            category,
            likes: isNaN(likes) ? 0 : likes,
            comment_count: isNaN(comment_count) ? 0 : comment_count 
          });
        }
      } catch (err) {
        console.error("[Scraper] Failed to parse post URL:", absoluteUrl, err);
      }
    }
  });

  return posts;
}
