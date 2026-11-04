import type { NextConfig } from "next";
import path from "node:path";

const containerBuild = process.env.DAYFORGE_CONTAINER_BUILD === "1";
const apiInternalOrigin = process.env.API_INTERNAL_ORIGIN ?? "http://127.0.0.1:8000";
const playwrightMockApi = process.env.DAYFORGE_PLAYWRIGHT_MOCK_API === "1";
const dayforgeBuildId = process.env.NEXT_PUBLIC_DAYFORGE_BUILD_ID ?? "development";

if (containerBuild && apiInternalOrigin !== "http://api:8000") {
  throw new Error("Container builds require API_INTERNAL_ORIGIN=http://api:8000.");
}

if (!containerBuild && apiInternalOrigin !== "http://127.0.0.1:8000") {
  throw new Error("API_INTERNAL_ORIGIN must be http://127.0.0.1:8000.");
}

if (containerBuild && playwrightMockApi) {
  throw new Error("The production container build cannot enable the Playwright mock API.");
}

const nextConfig: NextConfig = {
  agentRules: false,
  ...(containerBuild
    ? {
        output: "standalone" as const,
        outputFileTracingRoot: path.join(__dirname, ".."),
      }
    : {}),
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
