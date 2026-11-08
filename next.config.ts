import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // small self-contained server for the Docker image (deploy/Dockerfile)
  output: "standalone",
  // Let phones/tablets on the office network use the dev server (e.g. http://192.168.1.50:3000)
  allowedDevOrigins: ["192.168.*.*", "10.*.*.*"],
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  experimental: {
    serverActions: { bodySizeLimit: "12mb" },
  },
};

export default nextConfig;
