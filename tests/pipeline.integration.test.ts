import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * End-to-end test of the storage and retrieval path with the network stubbed.
 *
 * This is the test that earns its keep. The unit tests cover chunking, fusion
 * and query building in isolation, but the parts most likely to break in
 * practice are the seams: the sqlite-vec rowid binding (JS numbers bind as
 * REAL and the extension rejects them), the FTS5 external-content triggers,
 * partition-key filtering across repos, and neighbour expansion joining back
 * to the right file. None of that is exercised by testing pure functions, and
 * all of it fails loudly here if a schema or binding detail regresses.
 *
 * Only the OpenAI calls are faked. Everything else — SQLite, the vector
 * extension, the real ingestion pipeline — runs for real.
 */

const DB_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), "cda-test-")),
  "index.db",
);

process.env.OPENAI_API_KEY = "test-key-not-used";
process.env.DATABASE_PATH = DB_PATH;
process.env.LOG_LEVEL = "error";

/**
 * Deterministic stand-in for a real embedding model: hash tokens into a
 * 1536-dimension bag-of-words vector and L2-normalise.
 *
 * It is not semantic — it cannot match "authenticate" to "login" — but it is
 * a genuine vector space where lexical overlap produces higher cosine
 * similarity. That is enough to prove the plumbing ranks correctly, and unlike
 * a random or constant vector it would actually catch an ordering bug.
 */
const DIMENSIONS = 1536;

function fakeEmbedding(text: string): number[] {
  const vector = new Array<number>(DIMENSIONS).fill(0);
  const tokens =
    text
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter((t) => t.length > 2) ?? [];

  for (const token of tokens) {
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

const FIXTURE_FILES = [
  {
    path: "demo/package.json",
    content: JSON.stringify(
      {
        name: "demo-api",
        dependencies: { express: "^4.18.2", jsonwebtoken: "^9.0.0" },
        devDependencies: { vitest: "^1.0.0" },
      },
      null,
      2,
    ),
  },
  {
    path: "demo/README.md",
    content: "# Demo API\n\nA small Express service used as a test fixture.\n",
  },
  {
    path: "demo/src/auth/session.ts",
    content: `import jwt from "jsonwebtoken";

const SESSION_TTL_SECONDS = 3600;

export function createSession(userId: string): string {
  return jwt.sign({ sub: userId }, process.env.JWT_SECRET!, {
    expiresIn: SESSION_TTL_SECONDS,
  });
}

export function validateSession(token: string): string | null {
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET!) as { sub: string };
    return payload.sub;
  } catch {
    return null;
  }
}

export function revokeSession(token: string): void {
  revocationList.add(token);
}
`,
  },
  {
    path: "demo/src/api/routes.ts",
    content: `import express from "express";
import { validateSession } from "../auth/session";

const app = express();

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.post("/api/login", async (req, res) => {
  const session = await createSession(req.body.userId);
  res.json({ session });
});

app.delete("/api/session", (req, res) => {
  revokeSession(req.headers.authorization!);
  res.status(204).end();
});
`,
  },
  {
    path: "demo/src/db/connection.ts",
    content: `import { Pool } from "pg";

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
});

export async function withTransaction<T>(fn: (client: unknown) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } finally {
    client.release();
  }
}
`,
  },
  // Must be filtered out before it ever reaches the index.
  {
    path: "demo/node_modules/left-pad/index.js",
    content: "module.exports = function leftPad() { return 'nope'; };",
  },
  { path: "demo/package-lock.json", content: '{"lockfileVersion": 3}' },
];

type Pipeline = typeof import("@/lib/ingest/pipeline");
type Retrieval = typeof import("@/lib/retrieval");
type Db = typeof import("@/lib/db");

let pipeline: Pipeline;
let retrieval: Retrieval;
let db: Db;
let repoId: string;

beforeAll(async () => {
  // Dynamic import so the env vars above are set before the DB module
  // initialises and reads DATABASE_PATH.
  pipeline = await import("@/lib/ingest/pipeline");
  retrieval = await import("@/lib/retrieval");
  db = await import("@/lib/db");

  const started = pipeline.startIngestion({
    sourceType: "upload",
    sourceRef: "demo-api",
    files: FIXTURE_FILES,
  });
  repoId = started.id;
  await started.done;
}, 30_000);

afterAll(() => {
  fs.rmSync(path.dirname(DB_PATH), { recursive: true, force: true });
});

describe("ingestion", () => {
  it("finishes and marks the repository ready", () => {
    const repo = db
      .getDb()
      .prepare("SELECT status, file_count, chunk_count FROM repositories WHERE id = ?")
      .get(repoId) as { status: string; file_count: number; chunk_count: number };

    expect(repo.status).toBe("ready");
    expect(repo.file_count).toBe(5); // the two excluded fixtures are gone
    expect(repo.chunk_count).toBeGreaterThan(4);
  });

  it("excludes dependency and lockfile noise from the index", () => {
    const paths = (
      db.getDb().prepare("SELECT path FROM files WHERE repo_id = ?").all(repoId) as Array<{
        path: string;
      }>
    ).map((r) => r.path);

    expect(paths).toContain("src/auth/session.ts");
    expect(paths.some((p) => p.includes("node_modules"))).toBe(false);
    expect(paths).not.toContain("package-lock.json");
  });

  it("strips the uploaded root folder from stored paths", () => {
    const paths = (
      db.getDb().prepare("SELECT path FROM files WHERE repo_id = ?").all(repoId) as Array<{
        path: string;
      }>
    ).map((r) => r.path);
    expect(paths.every((p) => !p.startsWith("demo/"))).toBe(true);
  });

  it("writes one vector per chunk", () => {
    const chunks = db
      .getDb()
      .prepare("SELECT COUNT(*) AS n FROM chunks WHERE repo_id = ?")
      .get(repoId) as { n: number };
    const vectors = db
      .getDb()
      .prepare("SELECT COUNT(*) AS n FROM chunk_vectors WHERE repo_id = ?")
      .get(repoId) as { n: number };

    expect(vectors.n).toBe(chunks.n);
  });

  it("keeps the FTS index in sync via triggers", () => {
    const hits = db
      .getDb()
      .prepare(
        `SELECT COUNT(*) AS n FROM chunks_fts
         JOIN chunks c ON c.id = chunks_fts.rowid
         WHERE chunks_fts MATCH ? AND c.repo_id = ?`,
      )
      .get('"validatesession"', repoId) as { n: number };

    expect(hits.n).toBeGreaterThan(0);
  });

  it("builds a repo map with dependencies and routes", () => {
    const row = db
      .getDb()
      .prepare("SELECT repo_map FROM repositories WHERE id = ?")
      .get(repoId) as { repo_map: string };
    const map = JSON.parse(row.repo_map);

    expect(map.dependencies[0].runtime).toContain("express");
    expect(map.endpoints).toContainEqual(
      expect.objectContaining({ method: "POST", path: "/api/login" }),
    );
    expect(map.endpoints).toContainEqual(
      expect.objectContaining({ method: "GET", path: "/health" }),
    );
    expect(map.readmeExcerpt).toContain("Demo API");
  });
});

describe("hybrid retrieval", () => {
  it("finds the file that defines an identifier the user names exactly", async () => {
    const result = await retrieval.retrieve(repoId, "where is validateSession implemented");

    expect(result.chunks.length).toBeGreaterThan(0);
    expect(result.chunks.map((c) => c.filePath)).toContain("src/auth/session.ts");
    expect(result.stats.ftsQuery).toContain('"validatesession"');
  });

  it("routes a connection-pool question to the database module", async () => {
    const result = await retrieval.retrieve(repoId, "how is the postgres connection pool configured");
    expect(result.chunks[0].filePath).toBe("src/db/connection.ts");
  });

  it("reports which retriever surfaced each chunk", async () => {
    const result = await retrieval.retrieve(repoId, "validateSession jwt verify");
    const vias = new Set(result.chunks.map((c) => c.via));
    // At minimum something came from a real retriever, not just expansion.
    expect([...vias].some((v) => v === "vector" || v === "keyword" || v === "both")).toBe(true);
  });

  it("still answers when the keyword side finds nothing", async () => {
    // All stopwords — buildFtsQuery returns null and retrieval must fall back
    // to vector-only rather than throwing.
    const result = await retrieval.retrieve(repoId, "how does it do that");
    expect(result.stats.ftsQuery).toBeNull();
    expect(result.chunks.length).toBeGreaterThan(0);
  });

  it("respects the context token budget", async () => {
    const result = await retrieval.retrieve(repoId, "session token express route pool");
    const total = result.chunks.reduce((sum, c) => sum + c.tokenCount, 0);
    expect(result.stats.contextTokens).toBe(total);
    expect(total).toBeLessThanOrEqual(12_000);
  });

  it("never leaks chunks from another repository", async () => {
    const other = pipeline.startIngestion({
      sourceType: "upload",
      sourceRef: "other-repo",
      files: [
        {
          path: "other/src/session.ts",
          content:
            "export function validateSession(token: string) {\n  return token === 'other-repo-secret';\n}\n",
        },
      ],
    });
    await other.done;

    const result = await retrieval.retrieve(repoId, "validateSession");
    const ids = result.chunks.map((c) => c.chunkId);

    const leaked = db
      .getDb()
      .prepare(
        `SELECT COUNT(*) AS n FROM chunks WHERE repo_id != ? AND id IN (${ids
          .map(() => "?")
          .join(",")})`,
      )
      .get(repoId, ...ids) as { n: number };

    expect(leaked.n).toBe(0);

    pipeline.deleteRepository(other.id);
  });
});

describe("deleteRepository", () => {
  it("removes chunks, files and vectors together", async () => {
    const temp = pipeline.startIngestion({
      sourceType: "upload",
      sourceRef: "throwaway",
      files: [{ path: "t/src/index.ts", content: "export const answer = 42;\n" }],
    });
    await temp.done;

    pipeline.deleteRepository(temp.id);

    const counts = ["files", "chunks", "chunk_vectors"].map((table) => {
      const row = db
        .getDb()
        .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE repo_id = ?`)
        .get(temp.id) as { n: number };
      return row.n;
    });

    // chunk_vectors is a virtual table, so FK cascade does not reach it —
    // this asserts the explicit cleanup in deleteRepository still happens.
    expect(counts).toEqual([0, 0, 0]);
  });
});
