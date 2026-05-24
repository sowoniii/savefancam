import type { Post } from "./db";
import fs from "fs";
import path from "path";
import crypto from "crypto";

// 🚫 Known dcinside dummy / error / expired image MD5 hashes (to prevent disk space waste)
const DUMMY_IMAGE_MD5S = new Set([
  "3984034d00baacccbdb9a597705dc2cb", // "Connecting Hearts" logo.gif (when image is expired or invalid)
]);

// 💾 Helper to save image to our Oracle cloud VM local storage (public/uploads/)
function saveImageToLocalStorage(buffer: Buffer, originalUrl: string): string {
  try {
    // 🔒 100% Prevent Turbopack from scanning local images by injecting dynamic runtime-only process.env segments
    const publicFolder = process.env.PUBLIC_DIR_NAME || "public";
    const uploadsFolder = process.env.UPLOADS_DIR_NAME || "uploads";
    const uploadDir = path.join(process.cwd(), publicFolder, uploadsFolder);
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }

    // Try to extract original file extension, default to 'png'
    let ext = "png";
    try {
      const urlObj = new URL(originalUrl);
      const extMatch = urlObj.pathname.match(/\.([a-zA-Z0-9]+)(?:[?#]|$)/);
      if (extMatch) {
        const parsedExt = extMatch[1].toLowerCase();
        if (["jpg", "jpeg", "png", "gif", "webp", "mp4", "mov"].includes(parsedExt)) {
          ext = parsedExt;
        }
      }
    } catch {
      // Ignored
    }

    // Generate high-entropy secure unique filename to prevent collisions
    const fileName = `${Date.now()}_${crypto.randomBytes(4).toString("hex")}.${ext}`;
    const filePath = path.join(uploadDir, fileName);

    fs.writeFileSync(filePath, buffer);
    console.log(`💾 [Local Backup] Successfully saved image to Oracle disk: /uploads/${fileName}`);
    return `/uploads/${fileName}`;
  } catch (err) {
    console.error("❌ [Local Backup] Failed to write image to server storage:", err);
    return originalUrl;
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

        // 3. Save directly to Oracle local storage (public/uploads/)
        console.log(`[Local Storage] Backing up image [${index + 1}/${images.length}] locally.`);
        const localUrl = saveImageToLocalStorage(downloadedBuffer, originalUrl);
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
