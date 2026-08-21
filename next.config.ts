import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // `standalone` emits a self-contained server bundle, which keeps the Docker
  // image small. Vercel must NOT get it — the platform supplies its own build
  // adapter, and forcing standalone output fights it. `VERCEL` is set
  // automatically in their build environment.
  output: process.env.VERCEL ? undefined : "standalone",

  // `pg` is CommonJS and does `class Pool extends require("pg-pool")`. Bundled,
  // that require can resolve to an ES module namespace object, and extending
  // one throws at import time. Keeping it external hands it to Node's own
  // loader. The test runner needs the same treatment — see vitest.config.mts.
  serverExternalPackages: ["pg"],
};

export default nextConfig;
