import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Runs the eval harness itself with the network stubbed.
 *
 * An evaluation harness that has never been executed is worse than none — it
 * gets committed, looks reassuring, and fails the first time someone actually
 * needs it. This exercises the whole path (walk a directory, index it, score
 * every mode, clean up) so a refactor that breaks the harness fails CI rather
 * than surfacing later.
 */

const WORKDIR = fs.mkdtempSync(path.join(os.tmpdir(), "cda-eval-"));
const REPO_DIR = path.join(WORKDIR, "sample-project");

process.env.OPENAI_API_KEY = "test-key-not-used";
process.env.DATABASE_PATH = path.join(WORKDIR, "eval.db");
process.env.LOG_LEVEL = "error";

const DIMENSIONS = 1536;

function fakeEmbedding(text: string): number[] {
  const vector = new Array<number>(DIMENSIONS).fill(0);
  for (const token of text.toLowerCase().split(/[^a-z0-9_]+/)) {
    if (token.length < 3) continue;
    let hash = 2166136261;
    for (let i = 0; i < token.length; i++) {
      hash ^= token.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    vector[Math.abs(hash) % DIMENSIONS] += 1;
  }
  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0)) || 1;
  return vector.map((v) => v / norm);
}

vi.mock("@/lib/embeddings", () => ({
  embedTexts: async (texts: string[]) => ({
    vectors: texts.map(fakeEmbedding),
    tokens: texts.length * 10,
  }),
  embedQuery: async (text: string) => fakeEmbedding(text),
}));

type Harness = typeof import("@/eval/harness");
let harness: Harness;

beforeAll(async () => {
  fs.mkdirSync(path.join(REPO_DIR, "src", "auth"), { recursive: true });
  fs.mkdirSync(path.join(REPO_DIR, "src", "db"), { recursive: true });
  fs.mkdirSync(path.join(REPO_DIR, "node_modules", "junk"), { recursive: true });

  fs.writeFileSync(
    path.join(REPO_DIR, "src", "auth", "session.ts"),
    `export function validateSession(token: string) {\n  return verifyJwt(token);\n}\n`,
  );
  fs.writeFileSync(
    path.join(REPO_DIR, "src", "db", "pool.ts"),
    `export const pool = new Pool({ connectionString: process.env.DATABASE_URL });\n` +
      `export async function withTransaction(fn) { /* postgres transaction */ }\n`,
  );
  fs.writeFileSync(
    path.join(REPO_DIR, "node_modules", "junk", "index.js"),
    "module.exports = 1;\n",
  );

  harness = await import("@/eval/harness");
}, 30_000);

afterAll(() => {
  fs.rmSync(WORKDIR, { recursive: true, force: true });
});

describe("readDirectory", () => {
  it("walks source files and prunes dependency directories", () => {
    const { rootName, files } = harness.readDirectory(REPO_DIR);

    expect(rootName).toBe("sample-project");
    expect(files.map((f) => f.path)).toEqual(
      expect.arrayContaining([
        "sample-project/src/auth/session.ts",
        "sample-project/src/db/pool.ts",
      ]),
    );
    expect(files.some((f) => f.path.includes("node_modules"))).toBe(false);
  });
});

describe("runEvaluation", () => {
  it("scores every mode and cleans up the throwaway index", async () => {
    const report = await harness.runEvaluation({
      directory: REPO_DIR,
      k: 5,
      questions: [
        {
          id: "session",
          kind: "lexical",
          question: "Where is validateSession defined?",
          expectedFiles: ["src/auth/session.ts"],
        },
        {
          id: "pool",
          kind: "semantic",
          question: "How is the postgres connection pool created?",
          expectedFiles: ["src/db/pool.ts"],
        },
      ],
    });

    expect(report.fileCount).toBe(2);
    expect(report.chunkCount).toBeGreaterThan(0);
    expect(report.modes.map((m) => m.mode)).toEqual(["hybrid", "vector", "keyword"]);

    const hybrid = report.modes.find((m) => m.mode === "hybrid")!;
    expect(hybrid.recall).toBe(1);
    expect(hybrid.mrr).toBeGreaterThan(0);
    expect(hybrid.byKind.lexical).toEqual({ hits: 1, total: 1 });
    expect(hybrid.byKind.semantic).toEqual({ hits: 1, total: 1 });

    // Every question is accounted for, with a rank when it was a hit.
    for (const result of hybrid.results) {
      expect(result.hit).toBe(true);
      expect(result.rank).toBeGreaterThan(0);
    }

    // The eval index must not survive — otherwise it shows up in the app UI.
    const { getDb } = await import("@/lib/db");
    const row = getDb()
      .prepare("SELECT COUNT(*) AS n FROM repositories WHERE id = ?")
      .get(report.repoId) as { n: number };
    expect(row.n).toBe(0);
  }, 30_000);

  it("refuses to run against an empty directory", async () => {
    const empty = path.join(WORKDIR, "empty");
    fs.mkdirSync(empty, { recursive: true });

    await expect(
      harness.runEvaluation({ directory: empty, questions: [] }),
    ).rejects.toThrow(/No indexable files/);
  });
});
