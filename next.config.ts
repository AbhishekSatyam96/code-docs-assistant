import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // `standalone` emits a self-contained server bundle, which keeps the
  // production Docker image small (no full node_modules copy).
  output: "standalone",

  // `pg` is CommonJS and does `class Pool extends require("pg-pool")`. Bundled,
  // that require can resolve to an ES module namespace object, and extending
  // one throws at import time. Keeping it external hands it to Node's own
  // loader. The test runner needs the same treatment — see vitest.config.mts.
  serverExternalPackages: ["pg"],
};

export default nextConfig;
