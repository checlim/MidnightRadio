import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { NextConfig } from "next";

// The repo's .env (DATA_DIR, GENERATION_ENABLED, …) for local runs; values already set win.
const rootEnv = resolve(process.cwd(), "../../.env");
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

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
  // The shared station schema is TypeScript source in a workspace package.
  transpilePackages: ["@midnight-radio/core", "@midnight-radio/db"],
  webpack(config: { resolve: { extensionAlias?: Record<string, string[]> } }) {
    config.resolve.extensionAlias = { ".js": [".ts", ".tsx", ".js"] };
    return config;
  },
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
