import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Browser tests may run beside a developer's `next dev`. Giving that second
  // process its own distDir avoids Next's shared .next/dev lock and keeps its
  // generated artifacts out of the developer server.
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  poweredByHeader: false,
  experimental: {
    typedEnv: true,
  },
  async headers() {
    const securityHeaders = [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
      { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
      ...(process.env.NODE_ENV === "production"
        ? [{ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" }]
        : []),
    ];

    return [
      { source: "/(.*)", headers: securityHeaders },
      /*
       * The push worker, always fetched fresh. A browser otherwise keeps a
       * worker it has for up to a day, and a fix to what a notification opens
       * would reach a master's phone tomorrow. The file is a few hundred bytes
       * and checked rarely, so revalidating it costs nothing.
       */
      {
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
        ],
      },
    ];
  },
};

export default nextConfig;
