import type { NextConfig } from "next";

/**
 * The web app (Req 7). Security headers apply to every response: no framing, no sniffing, a
 * strict referrer policy, and a content security policy that only allows this site's own
 * scripts, styles, audio and transcripts.
 */
const csp = [
  "default-src 'self'",
  "script-src 'self'" + (process.env.NODE_ENV === "development" ? " 'unsafe-eval' 'unsafe-inline'" : " 'unsafe-inline'"),
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "media-src 'self'",
  "connect-src 'self'",
  "font-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default config;
