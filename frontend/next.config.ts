import type { NextConfig } from "next";

const apiInternalOrigin = process.env.API_INTERNAL_ORIGIN;
const playwrightMockApi = process.env.DAYFORGE_PLAYWRIGHT_MOCK_API === "1";
const dayforgeBuildId = process.env.NEXT_PUBLIC_DAYFORGE_BUILD_ID ?? "development";

if (apiInternalOrigin !== "http://127.0.0.1:8000") {
  throw new Error("API_INTERNAL_ORIGIN must be http://127.0.0.1:8000.");
}

const nextConfig: NextConfig = {
  agentRules: false,
  env: {
    NEXT_PUBLIC_DAYFORGE_BUILD_ID: dayforgeBuildId,
  },
  async headers() {
    const marker = { key: "X-Dayforge-Build", value: dayforgeBuildId };
    return [
      {
        source: "/:path*",
        headers: [marker],
      },
      {
        source: "/sw.js",
        headers: [
          marker,
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
      ...["/verify-email", "/reset-password"].map(source => ({
        source,
        headers: [
          marker,
          { key: "Cache-Control", value: "private, no-store" },
          { key: "Pragma", value: "no-cache" },
          { key: "Referrer-Policy", value: "no-referrer" },
        ],
      })),
    ];
  },
  async rewrites() {
    if (playwrightMockApi) return [];
    return [
      {
        source: "/api/v1/:path*",
        destination: `${apiInternalOrigin}/api/v1/:path*`,
      },
    ];
  },
};

export default nextConfig;
