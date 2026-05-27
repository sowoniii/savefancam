"use client";

import React, { useState } from 'react';
import { toPng } from 'html-to-image';

const fetchBase64Image = async (url: string, timeoutMs = 5000): Promise<string> => {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(url, { signal: controller.signal }).finally(() => clearTimeout(timeout));
    const blob = await response.blob();
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  } catch (e) {
    console.error('Failed to fetch image for base64:', e);
    return '';
  }
};

// Global cache variables to store Base64 versions of DC Inside sprite sheets.
// This prevents redundant local static fetches, reducing capture time to 0ms for sprites on subsequent clicks.
let cachedSpArrow = '';
let cachedSpImage = '';
let cachedSpIcon = '';
let cachedFontEmbedCSS = '';

const CAPTURE_CSS_WIDTH = 480;
const CAPTURE_PIXEL_RATIO = 2;
const MAX_CANVAS_DIMENSION = 32767; // Restored to 32767 to support 32734px max capture length as requested
const MAX_CAPTURE_SLICE_HEIGHT = Math.floor(MAX_CANVAS_DIMENSION / CAPTURE_PIXEL_RATIO) - 16;
const MIN_CAPTURE_SLICE_HEIGHT = 1024;

const buildFontEmbedCSS = async () => {
  const [regular, medium, bold] = await Promise.all([
    fetchBase64Image('/AppleSDGothicNeoR.ttf'),
    fetchBase64Image('/AppleSDGothicNeoM.ttf'),
    fetchBase64Image('/AppleSDGothicNeoB.ttf'),
  ]);

  return `
    @font-face {
      font-family: "Apple SD Gothic Neo";
      font-weight: 400;
      font-style: normal;
      font-display: block;
      src: url("${regular}") format("truetype");
    }
    @font-face {
      font-family: "Apple SD Gothic Neo";
      font-weight: 500;
      font-style: normal;
      font-display: block;
      src: url("${medium}") format("truetype");
    }
    @font-face {
      font-family: "Apple SD Gothic Neo";
      font-weight: 700;
      font-style: normal;
      font-display: block;
      src: url("${bold}") format("truetype");
    }
  `;
};

interface CaptureButtonProps {
  title: string;
  postId: string;
}

export default function CaptureButton({ title, postId }: CaptureButtonProps) {
  const [isCapturing, setIsCapturing] = useState(false);

  const handleCapture = async () => {
    if (isCapturing) return;
    setIsCapturing(true);

    let clone: HTMLElement | null = null;
    let wrapper: HTMLElement | null = null;

    try {
      // Find the grid container (contains the title, body, and comments)
      const element = (document.getElementById('post_content_wrapper') || document.querySelector('.grid')) as HTMLElement;
      if (!element) {
        alert('캡처할 영역을 찾지 못했습니다.');
        setIsCapturing(false);
        return;
      }

      // Fetch and cache sprite sheets as Base64 from local static files.
      // Fetching from local same-origin paths is incredibly fast, and caching makes it 0ms!
      if (!cachedSpArrow || !cachedSpImage || !cachedSpIcon) {
        const [spArrowBase64, spImageBase64, spIconBase64] = await Promise.all([
          fetchBase64Image('/dc/m/img/sp/sp_arrow.png'),
          fetchBase64Image('/dc/m/img/sp/sp_image.png'),
          fetchBase64Image('/dc/m/img/sp/sp_icon.png')
        ]);
        cachedSpArrow = spArrowBase64;
        cachedSpImage = spImageBase64;
        cachedSpIcon = spIconBase64;
      }

      // Use the cached base64 values
      const spArrowBase64 = cachedSpArrow;
      const spImageBase64 = cachedSpImage;
      const spIconBase64 = cachedSpIcon;

      // 1. Clone the target element in memory
      clone = element.cloneNode(true) as HTMLElement;

      // 2. Hide buttons that shouldn't appear in the archive (e.g. 목록보기, 글쓰기 등)
      const actionButtons = clone.querySelector('#view_btn_area');
      if (actionButtons) {
        (actionButtons as HTMLElement).style.display = 'none';
      }

      // Empty the text inside .sp-reload so it never bleeds or floats up due to negative text-indent SVG limits
      clone.querySelectorAll<HTMLElement>('.sp-reload').forEach((el) => {
        el.textContent = '';
      });

      // 3. Capture all images as data URLs to prevent html-to-image fetch issues
      // This fixes the issue where captured images are identical or fail to load.
      const liveImages = element.querySelectorAll('img');
      const clonedImages = clone.querySelectorAll('img');

      // Remove lazy loading attributes from all cloned images to prevent the browser's SVG engine
      // from suspending the rendering inside <foreignObject>
      clonedImages.forEach((img) => {
        img.removeAttribute('loading');
        img.removeAttribute('srcset');
        img.removeAttribute('sizes');
        // Force opacity to 1 and disable CSS keyframe fade-in animations during SVG rasterization
        img.style.setProperty('opacity', '1', 'important');
        img.style.setProperty('animation', 'none', 'important');
        img.style.setProperty('transition', 'none', 'important');
      });

      await Promise.all(
        Array.from(clonedImages).map(async (clonedImg, index: number) => {
          const liveImg = liveImages[index];
          if (liveImg) {
            // 3-1. If the live image is already fully loaded by the browser, use canvas to inline it instantly
            // We ensure naturalWidth > 10 to avoid capturing tiny/placeholder spacer gifs.
            if (liveImg.complete && liveImg.naturalWidth > 10) {
              try {
                const canvas = document.createElement('canvas');
                canvas.width = liveImg.naturalWidth;
                canvas.height = liveImg.naturalHeight;
                const ctx = canvas.getContext('2d');
                if (ctx) {
                  ctx.drawImage(liveImg, 0, 0);
                  const dataUrl = canvas.toDataURL('image/png');
                  clonedImg.src = dataUrl;
                  clonedImg.removeAttribute('srcset');
                  clonedImg.removeAttribute('sizes');
                  clonedImg.removeAttribute('loading'); // remove lazy loading
                  return;
                }
              } catch (e) {
                console.error('Failed to extract image data via canvas:', e);
              }
            }

            // 3-2. Fallback: If the image is not loaded yet (due to lazy loading),
            // fetch the image source directly as a base64 DataURL in parallel!
            const srcUrl = liveImg.src || clonedImg.src;
            if (srcUrl && !srcUrl.startsWith('data:')) {
              try {
                const base64Data = await fetchBase64Image(srcUrl);
                if (base64Data) {
                  clonedImg.src = base64Data;
                  clonedImg.removeAttribute('srcset');
                  clonedImg.removeAttribute('sizes');
                  clonedImg.removeAttribute('loading');
                  return;
                }
              } catch (err) {
                console.error('Failed to fetch fallback image base64:', err);
              }
            }

            // 3-3. Critical Safety Fallback: If both canvas extraction and network fallback fetch fail
            // (or time out), replace the image source with a 1x1 transparent spacer GIF.
            // This prevents html-to-image from making failed network requests for broken images,
            // which would trigger unhandled runtime exceptions and completely crash the screen capture!
            clonedImg.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
            clonedImg.removeAttribute('srcset');
            clonedImg.removeAttribute('sizes');
            clonedImg.removeAttribute('loading');
          }
        })
      );

      // 4. Capture the current frame of all playing videos (DC Inside silent MP4 GIFs)
      // Since video tags are usually rendered blank in canvas screenshots,
      // we draw their current frame onto a canvas, get the dataURL, and swap the video tags
      // in the clone with static <img> tags.
      const liveVideos = element.querySelectorAll('video');
      const clonedVideos = clone.querySelectorAll('video');

      clonedVideos.forEach((clonedVideo, index: number) => {
        const liveVideo = liveVideos[index];
        if (liveVideo) {
          try {
            const canvas = document.createElement('canvas');
            canvas.width = liveVideo.videoWidth || liveVideo.offsetWidth || 300;
            canvas.height = liveVideo.videoHeight || liveVideo.offsetHeight || 150;
            const ctx = canvas.getContext('2d');
            if (ctx) {
              ctx.drawImage(liveVideo, 0, 0, canvas.width, canvas.height);
              const dataUrl = canvas.toDataURL('image/png');

              // Create a static replacement image
              const img = document.createElement('img');
              img.src = dataUrl;
              img.className = clonedVideo.className;
              img.style.cssText = clonedVideo.style.cssText;
              img.style.width = '100%';
              img.style.height = 'auto';

              // Replace the video tag with the static image in our clone DOM
              if (clonedVideo.parentNode) {
                clonedVideo.parentNode.replaceChild(img, clonedVideo);
              }
            }
          } catch (e) {
            console.error('Failed to extract video frame for screenshot:', e);
          }
        }
      });

      // Embed the exact loaded font files without changing text metrics in the clone.
      if (document.fonts?.ready) {
        await document.fonts.ready;
      }

      if (!cachedFontEmbedCSS) {
        cachedFontEmbedCSS = await buildFontEmbedCSS();
      }

      // Convert all relative background URLs and local font-face source URLs in same-origin stylesheets
      // to absolute URLs so html-to-image can seamlessly download and inline them as Base64 into the SVG.
      let absoluteStyles = '';
      try {
        for (const sheet of Array.from(document.styleSheets)) {
          try {
            if (sheet.href && !sheet.href.startsWith(window.location.origin)) continue;
            const rules = Array.from(sheet.cssRules || sheet.rules || []);
            for (const rule of rules) {
              let cssText = rule.cssText;

              // Rewrite any url("/...") or url(/...) to url("http://origin/...")
              cssText = cssText.replace(/url\(\s*['"]?\/([^'"\)]+)['"]?\s*\)/g, (match, path) => {
                if (path.startsWith('http://') || path.startsWith('https://') || path.startsWith('data:')) {
                  return match;
                }
                return `url("${window.location.origin}/${path}")`;
              });

              absoluteStyles += cssText + '\n';
            }
          } catch {
            // Ignore security issues on cross-origin stylesheets
          }
        }
      } catch (e) {
        console.error('Failed to rewrite relative stylesheets:', e);
      }

      // Inject style sheet background overrides and custom absolute CSS rules
      const styleTag = document.createElement('style');
      styleTag.innerHTML = `
        ${absoluteStyles}
        
        .sel-box::after, .sp-reload::after, .sp-arrow::after, .all-comment-lst .comment-add::before {
          background-image: url('${spArrowBase64}') !important;
        }
        .comment-del .btn-ico-cmtdel, .sp-reply, .btn-commentgo::before, .veiw-top::before {
          background-image: url('${spImageBase64}') !important;
        }
        .sp-icon {
          background-image: url('${spIconBase64}') !important;
        }
        /* 닉네임이 잘려서 '익...'으로 나오지 않도록 강제 설정 */
        .ginfo-area .nick, .all-comment-lst .nick {
          max-width: none !important;
          width: auto !important;
          overflow: visible !important;
          text-overflow: clip !important;
          white-space: nowrap !important;
        }
        /* 작성일 등의 메타 정보가 다음 줄로 넘어가지 않도록 강제 설정 */
        .ginfo2 li, .ginfo-area {
          white-space: nowrap !important;
          word-break: keep-all !important;
        }
        /* 스크랩 등 불필요한 스크린 리더 텍스트 숨김 */
        .blind {
          display: none !important;
        }
      `;
      clone.appendChild(styleTag);

      // 5. Wrap clone inside a hidden container div and append to body off-screen.
      // This is crucial! If we apply left: -9999px directly to the clone element,
      // html-to-image's SVG renderer will draw the clone 9999px off-canvas inside the SVG,
      // resulting in a completely blank/white image output!
      wrapper = document.createElement('div');
      // 복제된 요소가 실제 페이지와 완전히 동일한 부모 스타일 환경(테마, 배경색, 레이아웃 컨텍스트)을 갖도록 클래스들을 부여
      wrapper.className = 'archive-shell theme-mini';
      wrapper.style.position = 'fixed';
      wrapper.style.top = '0';
      wrapper.style.left = '-9999px';
      wrapper.style.width = `${CAPTURE_CSS_WIDTH}px`;
      wrapper.style.maxWidth = 'none';
      wrapper.style.height = 'auto';
      wrapper.style.overflow = 'hidden';

      const captureFrame = document.createElement('div');
      captureFrame.style.position = 'relative';
      captureFrame.style.width = `${CAPTURE_CSS_WIDTH}px`;
      captureFrame.style.maxWidth = 'none';
      captureFrame.style.height = 'auto';
      captureFrame.style.overflow = 'hidden';
      captureFrame.style.backgroundColor = '#ffffff';

      // Ensure the clone itself has normal relative layout inside the wrapper at (0,0)
      clone.style.width = `${CAPTURE_CSS_WIDTH}px`;
      clone.style.maxWidth = 'none';
      clone.style.height = 'auto';
      clone.style.position = 'relative';
      clone.style.left = '0';
      clone.style.top = '0';
      clone.style.paddingBottom = '80px'; // Prevent bottom clipping of comments list due to SVG text rendering metrics

      captureFrame.appendChild(clone);
      wrapper.appendChild(captureFrame);
      document.body.appendChild(wrapper);

      // 5.5 Wait for all images in the cloned tree to be fully parsed and decoded by the browser.
      // This is absolutely crucial to prevent race conditions where base64 images render as small/placeholder boxes.
      // We enforce a strict 500ms maximum timeout using Promise.race to guarantee lightning-fast user experience!
      const clonedImagesList = Array.from(clone.querySelectorAll('img'));
      const decodePromise = Promise.all(
        clonedImagesList.map((img) => {
          if (img.src) {
            // img.decode() forces the browser to fully decode and layout the image before resolving
            return img.decode().catch((err: unknown) => {
              console.warn('Image decode failed or timed out:', err);
            });
          }
          return Promise.resolve();
        })
      );

      const timeoutPromise = new Promise((resolve) => setTimeout(resolve, 500));
      await Promise.race([decodePromise, timeoutPromise]);

      const captureHeight = Math.ceil(Math.max(
        clone.scrollHeight,
        clone.offsetHeight,
        clone.getBoundingClientRect().height
      ));
      const captureTarget = clone;

      // 6. Convert clone (NOT wrapper) to PNG so it is drawn centered on the canvas at (0, 0)
      const downloadPng = (dataUrl: string, fileName: string) => {
        if (!dataUrl.startsWith('data:image/png')) {
          throw new Error('Capture produced an invalid PNG data URL.');
        }

        const link = document.createElement('a');
        link.href = dataUrl;
        link.download = fileName;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
      };

      const captureSlice = async (offsetY: number, sliceHeight: number) => {
        captureFrame.style.height = `${sliceHeight}px`;
        captureTarget.style.transform = `translateY(-${offsetY}px)`;

        return toPng(captureFrame, {
          backgroundColor: '#ffffff',
          width: CAPTURE_CSS_WIDTH,
          height: sliceHeight,
          canvasWidth: CAPTURE_CSS_WIDTH,
          canvasHeight: sliceHeight,
          pixelRatio: CAPTURE_PIXEL_RATIO,
          fontEmbedCSS: cachedFontEmbedCSS,
          skipAutoScale: true,
          style: {
            width: `${CAPTURE_CSS_WIDTH}px`,
            maxWidth: 'none',
            height: `${sliceHeight}px`,
          },
        });
      };

      const captureValidSlice = async (offsetY: number, requestedHeight: number) => {
        let sliceHeight = requestedHeight;

        while (sliceHeight >= MIN_CAPTURE_SLICE_HEIGHT) {
          try {
            const dataUrl = await captureSlice(offsetY, sliceHeight);
            if (dataUrl.startsWith('data:image/png')) {
              return { dataUrl, sliceHeight };
            }
          } catch (error) {
            console.warn('Capture slice was too tall, retrying smaller:', error);
          }

          sliceHeight = Math.floor(sliceHeight / 2);
        }

        const dataUrl = await captureSlice(offsetY, sliceHeight);
        return { dataUrl, sliceHeight };
      };

      const safeTitle = title.replace(/[\s/\\:*?"<>|]/g, '_');
      let partIndex = 0;
      let offsetY = 0;
      const estimatedParts = Math.ceil(captureHeight / MAX_CAPTURE_SLICE_HEIGHT);

      while (offsetY < captureHeight) {
        const requestedHeight = Math.min(MAX_CAPTURE_SLICE_HEIGHT, captureHeight - offsetY);
        const { dataUrl, sliceHeight } = await captureValidSlice(offsetY, requestedHeight);
        const partSuffix = estimatedParts > 1 ? `_part${String(partIndex + 1).padStart(2, '0')}` : '';

        downloadPng(dataUrl, `${safeTitle}_아카이브_${postId}${partSuffix}.png`);
        offsetY += sliceHeight;
        partIndex += 1;
      }
    } catch (error: unknown) {
      console.error('Capture error:', error);
      alert('캡처 중 오류가 발생했습니다. 개발자 도구(F12) 콘솔을 확인해 주세요.');
    } finally {
      // 7. Cleanup wrapper from document
      if (wrapper?.parentNode) {
        wrapper.parentNode.removeChild(wrapper);
      }
      setIsCapturing(false);
    }
  };

  return (
    <button
      onClick={handleCapture}
      disabled={isCapturing}
      className="btn-write archive-capture-button"
      title="이 페이지 전체를 실제 화면과 100% 똑같은 이미지로 캡처하여 저장합니다. (움짤 포함)"
    >
      {isCapturing ? '캡처 중...' : '화면 캡처'}
    </button>
  );
}
