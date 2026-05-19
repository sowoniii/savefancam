import { NextRequest, NextResponse } from 'next/server';

const PROXY_TIMEOUT_MS = Number(process.env.PROXY_IMAGE_TIMEOUT_MS || 15000);
export async function GET(request: NextRequest) {
  const url = request.nextUrl.searchParams.get('url');

  if (!url) {
    return new NextResponse('URL parameter is required', { status: 400 });
  }

  try {
    const parsedUrl = new URL(url);
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      return new NextResponse('Only HTTP(S) URLs are allowed', { status: 400 });
    }
    const hostname = parsedUrl.hostname.toLowerCase();
    
    // SSRF 방어를 위해 로컬/사설 IP 및 루프백 주소 차단
    const isLocal = hostname === 'localhost' ||
                    hostname === '127.0.0.1' ||
                    hostname.startsWith('10.') ||
                    hostname.startsWith('192.168.') ||
                    hostname.startsWith('172.16.') ||
                    hostname.startsWith('169.254.') ||
                    hostname.endsWith('.local') ||
                    hostname.endsWith('.internal');

    if (isLocal) {
      return new NextResponse('Local hosts are not allowed', { status: 400 });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);
    const response = await fetch(url, {
      headers: {
        'Referer': 'https://m.dcinside.com/',
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
      },
      signal: controller.signal,
    }).finally(() => clearTimeout(timeout));

    if (!response.ok) {
      return new NextResponse(`Failed to fetch image: ${response.statusText}`, { status: response.status });
    }

    if (!response.body) {
      return new NextResponse('Empty response body from DC Inside', { status: 500 });
    }

    // 1. Read the very first chunk of the stream to inspect binary magic bytes.
    // This allows us to detect GIF, WebP, PNG, JPEG, and MP4 formats with 100% accuracy,
    // even if DC Inside returns no file extensions and generic application/octet-stream headers.
    const reader = response.body.getReader();
    const { value, done } = await reader.read();

    let contentType = response.headers.get('content-type') || 'application/octet-stream';

    // If it's a generic octet-stream or if we want to guarantee accuracy, inspect magic bytes
    if (contentType === 'application/octet-stream' && value && value.length >= 4) {
      const hex = Array.from(value.slice(0, 12))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('')
        .toLowerCase();

      if (hex.startsWith('47494638')) { // GIF87a / GIF89a
        contentType = 'image/gif';
      } else if (hex.startsWith('89504e47')) { // PNG
        contentType = 'image/png';
      } else if (hex.startsWith('ffd8ff')) { // JPEG
        contentType = 'image/jpeg';
      } else if (hex.startsWith('52494646') && hex.substring(16, 24) === '57454250') { // RIFF ... WEBP
        contentType = 'image/webp';
      } else if (hex.startsWith('1a45dfa3')) { // WebM
        contentType = 'video/webm';
      } else if (hex.substring(8, 16) === '66747970') { // ftyp (MP4)
        contentType = 'video/mp4';
      }
    }

    // 2. Fallback to filename/header inspection if magic bytes didn't resolve it
    if (contentType === 'application/octet-stream') {
      const contentDisp = response.headers.get('content-disposition') || '';
      const filenameMatch = contentDisp.match(/filename="?([^";\n]+)"?/i) || url.match(/\/([^/?#]+)(?:[?#]|$)/);
      if (filenameMatch) {
        const filename = filenameMatch[1].toLowerCase();
        if (filename.endsWith('.jpg') || filename.endsWith('.jpeg')) {
          contentType = 'image/jpeg';
        } else if (filename.endsWith('.png')) {
          contentType = 'image/png';
        } else if (filename.endsWith('.gif')) {
          contentType = 'image/gif';
        } else if (filename.endsWith('.webp')) {
          contentType = 'image/webp';
        } else if (filename.endsWith('.mp4')) {
          contentType = 'video/mp4';
        } else if (filename.endsWith('.webm')) {
          contentType = 'video/webm';
        }
      }
    }

    const headers = new Headers();
    headers.set('Content-Type', contentType);
    headers.set('Cache-Control', 'public, max-age=31536000, immutable');
    headers.set('Access-Control-Allow-Origin', '*');
    headers.set('Access-Control-Allow-Methods', 'GET, OPTIONS');

    // 3. Reconstruct a new ReadableStream using the first chunk and the remaining reader stream
    // to preserve memory-efficient response streaming (no OOM crashes for large GIFs/videos).
    const stream = new ReadableStream({
      async start(controller) {
        if (value) {
          controller.enqueue(value);
        }
        if (done) {
          controller.close();
          return;
        }
        try {
          while (true) {
            const { value: nextValue, done: nextDone } = await reader.read();
            if (nextDone) {
              controller.close();
              break;
            }
            controller.enqueue(nextValue);
          }
        } catch (err) {
          controller.error(err);
        }
      }
    });

    return new NextResponse(stream, {
      status: response.status,
      headers,
    });
  } catch (error: unknown) {
    console.error('Proxy Media Error:', error);
    const message = error instanceof Error ? error.message : String(error);
    return new NextResponse(`Error fetching media: ${message}`, { status: 500 });
  }
}
