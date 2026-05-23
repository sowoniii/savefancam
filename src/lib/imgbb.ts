import type { Post } from "./db";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import sharp from "sharp";

// 🚫 Known dcinside dummy / error / expired image MD5 hashes (to prevent disk space waste)
const DUMMY_IMAGE_MD5S = new Set([
  "3984034d00baacccbdb9a597705dc2cb", // "Connecting Hearts" logo.gif (when image is expired or invalid)
]);

// 💾 Helper to compress and save image to local storage using high-performance Sharp (WebP conversion)
async function saveImageToLocalStorage(buffer: Buffer, originalUrl: string): Promise<string> {
  try {
    const uploadDir = path.join(process.cwd(), "public", "uploads");
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }

    // 1. Try to extract original file extension, default to 'png'
    let originalExt = "png";
    try {
      const urlObj = new URL(originalUrl);
      const extMatch = urlObj.pathname.match(/\.([a-zA-Z0-9]+)(?:[?#]|$)/);
      if (extMatch) {
        originalExt = extMatch[1].toLowerCase();
      }
    } catch {
      // Ignored
    }

    // 2. Generate secure unique filename with '.webp' extension
    // We convert everything (JPG, PNG, GIF) to .webp for high efficiency!
    // Except mp4/mov videos which should be saved as is.
    const isVideo = ["mp4", "mov"].includes(originalExt);
    const targetExt = isVideo ? originalExt : "webp";
    
    const fileName = `${Date.now()}_${crypto.randomBytes(4).toString("hex")}.${targetExt}`;
    const filePath = path.join(uploadDir, fileName);

    if (isVideo) {
      // Videos are written as-is
      await fs.promises.writeFile(filePath, buffer);
      console.log(`💾 [Local Backup] Saved video to Oracle disk: /uploads/${fileName}`);
    } else {
      // 🚀 Apply High-Performance Compression / Resizing via Sharp!
      let pipeline = sharp(buffer);
      const metadata = await pipeline.metadata();

      if (originalExt === "gif" || metadata.format === "gif") {
        // GIF 움짤 -> 고효율 애니메이션 WebP 변환 (움직임 보존하며 용량 최대 80% 절감!)
        // quality 70 is the sweet spot for animated webp.
        console.log(`⚡ [Sharp Compression] Converting animated GIF to WebP...`);
        const compressedBuffer = await pipeline
          .webp({ animated: true, quality: 70 })
          .toBuffer();
        await fs.promises.writeFile(filePath, compressedBuffer);
      } else {
        // 일반 사진 (JPG, PNG) -> 가로 최대 1200px 지능형 리사이징 및 고성능 WebP 변환
        // (용량 3MB -> 200KB로 95% 폭풍 다이어트!)
        const targetWidth = 1200;
        if (metadata.width && metadata.width > targetWidth) {
          pipeline = pipeline.resize({ width: targetWidth, withoutEnlargement: true });
        }
        
        const compressedBuffer = await pipeline
          .webp({ quality: 75 })
          .toBuffer();
        await fs.promises.writeFile(filePath, compressedBuffer);
      }
      
      const beforeKB = Math.round(buffer.length / 1024);
      const afterKB = Math.round((await fs.promises.stat(filePath)).size / 1024);
      const savedPercent = Math.max(0, Math.round((1 - afterKB / beforeKB) * 100));
      console.log(`💾 [Local Backup] Compressed and saved WebP: /uploads/${fileName} (${beforeKB}KB -> ${afterKB}KB, ${savedPercent}% saved!)`);
    }

    return `/uploads/${fileName}`;
  } catch (err) {
    console.error("❌ [Local Backup] Failed to write image to server storage:", err);
    // Fail-safe fallback: if compression fails, write raw buffer as png
    try {
      const fallbackName = `${Date.now()}_${crypto.randomBytes(4).toString("hex")}.png`;
      const fallbackPath = path.join(process.cwd(), "public", "uploads", fallbackName);
      await fs.promises.writeFile(fallbackPath, buffer);
      return `/uploads/${fallbackName}`;
    } catch {
      return originalUrl;
    }
  }
}

export async function uploadPostImagesToImgBB(post: Omit<Post, 'id' | 'archived_at'>): Promise<Omit<Post, 'id' | 'archived_at'>> {
  let images: string[] = [];
  try {
    images = JSON.parse(post.images_json || "[]");
  } catch (e) {
    console.error("[Local Storage] Failed to parse images_json:", e);
    return post;
  }

  if (images.length === 0) {
    return post;
  }

  console.log(`[Local Storage] Starting direct local backup for ${images.length} images...`);

  const results: { originalUrl: string; newUrl: string }[] = [];
  const concurrency = Math.max(1, Number(process.env.IMGBB_UPLOAD_CONCURRENCY || 3));

  let currentIndex = 0;

  async function worker() {
    while (currentIndex < images.length) {
      const index = currentIndex++;
      const originalUrl = images[index];
      let downloadedBuffer: Buffer | null = null;

      try {
        // 1. Download image from DC Inside (with referer spoofing to avoid 403 Forbidden)
        const res = await fetch(originalUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1",
            "Referer": "https://m.dcinside.com/"
          }
        });

        if (!res.ok) {
          throw new Error(`Failed to fetch original image. Status: ${res.status}`);
        }

        const arrayBuffer = await res.arrayBuffer();
        downloadedBuffer = Buffer.from(arrayBuffer);

        // 2. Detect and filter out DC Inside dummy error images to save disk space
        const md5 = crypto.createHash("md5").update(downloadedBuffer).digest("hex");
        if (DUMMY_IMAGE_MD5S.has(md5)) {
          console.log(`⚠️ [Local Storage] Skipping dummy error image ("Connecting Hearts") [${index + 1}/${images.length}] to save space.`);
          results.push({ originalUrl, newUrl: originalUrl });
          continue;
        }

        // 2. Save directly to Oracle local storage (public/uploads/)
        console.log(`[Local Storage] Backing up image [${index + 1}/${images.length}] locally.`);
        const localUrl = await saveImageToLocalStorage(downloadedBuffer, originalUrl);
        results.push({ originalUrl, newUrl: localUrl });

      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[Local Storage] Backup failed for [${index + 1}/${images.length}] (${originalUrl}): ${message}`);
        
        // If downloading the image itself failed, we have no choice but to fallback to raw DC URL
        results.push({ originalUrl, newUrl: originalUrl });
      }
    }
  }

  // Start the sliding window workers in parallel
  const workers = Array.from({ length: Math.min(concurrency, images.length) }, worker);
  await Promise.all(workers);

  const uploadedMap: { [originalUrl: string]: string } = {};
  for (const r of results) {
    uploadedMap[r.originalUrl] = r.newUrl;
  }

  // 3. Update images_json array with new backup URLs
  const newImages = images.map(url => uploadedMap[url] || url);
  post.images_json = JSON.stringify(newImages);

  // 4. Replace original URLs inside content_html with new backup URLs
  let contentHtml = post.content_html;
  for (const originalUrl of Object.keys(uploadedMap)) {
    const newUrl = uploadedMap[originalUrl];
    if (newUrl && newUrl !== originalUrl) {
      contentHtml = contentHtml.replaceAll(originalUrl, newUrl);
    }
  }
  post.content_html = contentHtml;

  // 5. Update has_image flag
  post.has_image = newImages.length > 0;

  console.log(`[Local Storage] Finished parallel image backup for post: "${post.title}"`);
  return post;
}
