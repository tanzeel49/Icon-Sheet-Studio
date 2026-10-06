import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  /* allow the sandbox preview gateway origin to request /_next/* assets
   * (dev-only warning suppression — Next 16 requires explicit dev origins) */
  allowedDevOrigins: ["https://*.space-z.ai"],
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
};

export default nextConfig;
