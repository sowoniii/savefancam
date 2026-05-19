async function test() {
  const dcconUrl = "https://nstatic.dcinside.com/dcon/canvas/img/emoticon.gif"; // a typical dccon path pattern
  const proxyUrl = `http://localhost:3000/api/proxy-image?url=${encodeURIComponent(dcconUrl)}`;
  console.log("Testing proxy with url:", dcconUrl);
  try {
    const res = await fetch(dcconUrl, {
      headers: {
        'Referer': 'https://m.dcinside.com/',
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
      }
    });
    console.log("Direct fetch status:", res.status);
    console.log("Direct fetch content-type:", res.headers.get("content-type"));
  } catch (e: any) {
    console.error("Direct fetch failed:", e.message);
  }
}

test();
