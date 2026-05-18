export async function uploadPostImagesToImgBB(post: any): Promise<any> {
  const apiKey = process.env.IMGBB_API_KEY;
  if (!apiKey) {
    console.log("ℹ️ [ImgBB] No API Key found. Skipping image upload to ImgBB.");
    return post;
  }

  console.log(`[ImgBB] Starting image upload to ImgBB for post: "${post.title}"...`);

  let images: string[] = [];
  try {
    images = JSON.parse(post.images_json || "[]");
  } catch (e) {
    console.error("[ImgBB] Failed to parse images_json:", e);
    return post;
  }

  if (images.length === 0) {
    return post;
  }

  console.log(`[ImgBB] Processing ${images.length} images with concurrent sliding-window worker pool...`);

  const results: { originalUrl: string; newUrl: string }[] = [];
  const concurrency = 8; // Optimal number of parallel workers

  let currentIndex = 0;

  async function worker() {
    while (currentIndex < images.length) {
      const index = currentIndex++;
      const originalUrl = images[index];

      try {
        // 1. Fetch image from DC Inside with spoofed referer header
        const res = await fetch(originalUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1",
            "Referer": "https://m.dcinside.com/"
          }
        });

        if (!res.ok) {
          throw new Error(`Failed to fetch image. Status: ${res.status}`);
        }

        const buffer = await res.arrayBuffer();
        const base64Image = Buffer.from(buffer).toString("base64");

        // 2. Upload to ImgBB using FormData
        const formData = new FormData();
        formData.append("image", base64Image);

        const uploadRes = await fetch(`https://api.imgbb.com/1/upload?key=${apiKey}`, {
          method: "POST",
          body: formData
        });

        if (!uploadRes.ok) {
          const errText = await uploadRes.text();
          throw new Error(`ImgBB Upload failed: ${errText}`);
        }

        const uploadData = await uploadRes.json();
        const newUrl = uploadData.data?.url;

        if (newUrl) {
          console.log(`[ImgBB] Successfully uploaded image [${index + 1}/${images.length}]: ${newUrl}`);
          results.push({ originalUrl, newUrl });
        } else {
          throw new Error("ImgBB API did not return an image URL");
        }
      } catch (err: any) {
        console.error(`[ImgBB] Failed to upload image [${index + 1}/${images.length}] (${originalUrl}):`, err.message);
        results.push({ originalUrl, newUrl: originalUrl }); // Fallback to original URL
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

  // 3. Update images_json array with new ImgBB URLs
  const newImages = images.map(url => uploadedMap[url] || url);
  post.images_json = JSON.stringify(newImages);

  // 4. Replace original URLs inside content_html with new ImgBB URLs
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

  console.log(`[ImgBB] Finished parallel image upload to ImgBB for post: "${post.title}"`);
  return post;
}
