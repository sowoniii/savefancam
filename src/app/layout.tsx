import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "SaveFancam Archive | 프리뷰, 직캠, 고화질 보존",
  description: "디시인사이드 특정 갤러리의 소중한 게시글, 직캠, 사진을 영구적으로 보존하는 아카이브입니다.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko">
      <head>
        <link rel="manifest" href="/manifest.json" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="default" />
        <meta name="theme-color" content="#d22d2d" />
        
        <link rel="preload" href="/AppleSDGothicNeoR.ttf" as="font" type="font/ttf" crossOrigin="anonymous" />
        <link rel="preload" href="/AppleSDGothicNeoM.ttf" as="font" type="font/ttf" crossOrigin="anonymous" />
        <link rel="preload" href="/AppleSDGothicNeoB.ttf" as="font" type="font/ttf" crossOrigin="anonymous" />
        <link rel="preload" href="/dc/m/img/sp/sp_header.png?210527" as="image" type="image/png" fetchPriority="high" />
        <link rel="preload" href="/dc/m/img/sp/sp_arrow.png?230920-1" as="image" type="image/png" fetchPriority="high" />
        <link rel="preload" href="/dc/m/img/sp/sp_icon.png?0914" as="image" type="image/png" fetchPriority="high" />
        <link rel="preload" href="/dc/m/img/sp/sp_lst.png?220531-2" as="image" type="image/png" fetchPriority="high" />
        <link rel="preload" href="/dc/m/img/sp/sp_image.png?0305" as="image" type="image/png" fetchPriority="high" />
        {/* eslint-disable-next-line @next/next/no-css-tags -- DC vendor CSS contains legacy browser-tolerated syntax that Next/PostCSS cannot parse safely. */}
        <link rel="stylesheet" href="/dc-vendor.css" />
      </head>
      <body className="archive-body">
        <div className="archive-shell theme-mini">
          {children}
        </div>
      </body>
    </html>
  );
}
