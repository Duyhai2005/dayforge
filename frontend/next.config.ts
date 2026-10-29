import type { NextConfig } from "next";

const apiInternalOrigin = process.env.API_INTERNAL_ORIGIN;

if (apiInternalOrigin !== "http://127.0.0.1:8000") {
  throw new Error("API_INTERNAL_ORIGIN must be http://127.0.0.1:8000.");
}

const nextConfig: NextConfig = {
  agentRules: false,
  async headers() {
    return ["/verify-email", "/reset-password"].map(source => ({
      source,
      headers: [
        { key: "Cache-Control", value: "private, no-store" },
        { key: "Pragma", value: "no-cache" },
        { key: "Referrer-Policy", value: "no-referrer" },
      ],
    }));
  },
  async rewrites() {
    return [
      {
        source: "/api/v1/:path*",
        destination: `${apiInternalOrigin}/api/v1/:path*`,
      },
    ];
  },
};

export default nextConfig;
