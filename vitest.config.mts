import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
    /**
     * `server-only` throws on import unless resolved under the `react-server`
     * condition, which maps it to an empty module. Declaring the condition —
     * rather than stubbing the package with an alias — means tests resolve it
     * exactly the way `npm run eval` does.
     *
     * That difference was not academic: an alias-based stub hid a crash in the
     * eval CLI, because the tests never loaded the real package.
     */
    conditions: ["react-server", "node", "import", "default"],
  },
  // Vitest runs test files through its SSR pipeline, which resolves bare
  // imports with `ssr.resolve.conditions` rather than the client-side list
  // above. Both are set so the condition applies whichever path a module
  // takes.
  ssr: {
    resolve: {
      conditions: ["react-server", "node", "import", "default"],
      externalConditions: ["react-server", "node", "import", "default"],
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
