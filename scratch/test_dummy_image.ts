import crypto from "crypto";

async function test() {
  // Let's request an invalid image URL which triggers the dummy "Connecting Hearts" error image.
  const url = "https://dcimg6.dcinside.co.kr/viewimage.php?id=invalid_id&no=invalid_no";
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1",
        "Referer": "https://m.dcinside.com/"
      }
    });

    console.log("Status:", res.status);
    console.log("Headers:", Object.fromEntries(res.headers.entries()));

    const arrayBuffer = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const byteSize = buffer.length;
    const md5 = crypto.createHash("md5").update(buffer).digest("hex");
    const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");

    console.log("Image Byte Size:", byteSize);
    console.log("MD5 Hash:", md5);
    console.log("SHA256 Hash:", sha256);
  } catch (e) {
    console.error(e);
  }
}

test();
