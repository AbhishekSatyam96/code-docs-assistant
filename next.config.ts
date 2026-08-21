import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // `standalone` emits a self-contained server bundle, which keeps the
  // production Docker image small (no full node_modules copy).
  output: "standalone",

  // Native/loadable-extension modules must be `require`d at runtime rather
  // than bundled. `better-sqlite3` is on Next's built-in list; `sqlite-vec`
  // resolves a platform-specific `.dylib`/`.so` and has to be added here.
  serverExternalPackages: ["better-sqlite3", "sqlite-vec"],
};

export default nextConfig;
