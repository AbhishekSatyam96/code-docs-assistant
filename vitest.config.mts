import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },

  ssr: {
    resolve: {
      /**
       * Only `react-server` is added, on top of Vite's own defaults.
       *
       * It is needed so `server-only` resolves to its empty module instead of
       * the one that throws — the same condition `npm run eval` passes to tsx,
       * so tests and the CLI resolve identically. An earlier version of this
       * file stubbed `server-only` with an alias instead, and that divergence
       * hid a crash in the eval CLI that the tests could not see.
       *
       * What must NOT be added here is `import`. `pg` and `pg-pool` both map
       * that condition to an ESM build, so `pg`'s internal
       * `class Pool extends require("pg-pool")` would receive a module
       * namespace object and throw "Class extends value [object Module]".
       */
      conditions: ["react-server"],
    },
  },

  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    server: {
      deps: {
        // Belt and braces alongside the condition note above: let Node's own
        // loader handle the driver, exactly as Next.js does in production via
        // `serverExternalPackages`.
        external: ["pg", "pg-pool", "pg-native"],
      },
    },
    // Integration tests reach a real Postgres over the network; the default
    // 5s timeout is not enough for a first connection plus schema creation.
    testTimeout: 60_000,
    hookTimeout: 120_000,
    coverage: {
      provider: "v8",
      include: ["src/lib/**/*.ts"],
      // The excluded modules are thin I/O wrappers over Postgres and the
      // OpenAI SDK. Covering them means asserting that a mock was called,
      // which tests the mock rather than the code. The logic worth testing —
      // chunking, fusion, query building, filtering — is covered directly.
      exclude: ["src/lib/db/schema.ts", "src/lib/llm/client.ts", "src/lib/embeddings/**"],
    },
  },
});
