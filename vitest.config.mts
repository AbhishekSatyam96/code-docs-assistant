import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
      // `server-only` throws when imported outside a React Server Component.
      // Tests exercise the pure logic in those modules, so it is stubbed.
      "server-only": path.resolve(import.meta.dirname, "./tests/stubs/server-only.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/lib/**/*.ts"],
      // The excluded modules are thin I/O wrappers over SQLite and the OpenAI
      // SDK. Covering them means asserting that a mock was called, which
      // tests the mock rather than the code. The logic worth testing —
      // chunking, fusion, query building, filtering — is covered directly.
      exclude: ["src/lib/db/schema.ts", "src/lib/llm/client.ts", "src/lib/embeddings/**"],
    },
  },
});
