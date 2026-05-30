import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // output: "standalone",
  poweredByHeader: false,
  reactCompiler: true,
  typescript: {
    // 🚀 Speed up compilation on resource-constrained Oracle Free Tier
    ignoreBuildErrors: true,
  },
  experimental: {
    // 🚀 Force single-threaded compilation to prevent Out-Of-Memory freezes on 1GB Oracle Cloud VM
    cpus: 1,
  },
  async headers() {
    return [
      {
        source: "/dc/:path*",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=31536000, immutable",
          },
        ],
      },
      {
        source: "/:asset(dc-vendor|reset|common|contents|popup|minor|talk).css",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=86400, stale-while-revalidate=604800",
          },
        ],
      },
      {
        source: "/:font(AppleSDGothicNeoR|AppleSDGothicNeoM|AppleSDGothicNeoB).ttf",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=31536000, immutable",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
