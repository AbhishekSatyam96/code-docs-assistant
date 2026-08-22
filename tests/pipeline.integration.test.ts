import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * End-to-end test of the storage and retrieval path with the network stubbed.
 *
 * This is the test that earns its keep. The unit tests cover chunking, fusion
 * and query building in isolation, but the parts most likely to break are the
 * seams: pgvector's text-literal cast on both write and read, the generated
 * `tsvector` column, `ANY($1::bigint[])` array binding, BIGINT arriving as a
 * string from `pg`, and the neighbour self-join. None of that is exercised by
 * testing pure functions, and all of it fails loudly here.
 *
 * Only the OpenAI calls are faked. Postgres and pgvector run for real.
 *
 * ## Why this needs a database, and how it stays safe
 * The SQLite version ran with zero setup in a temp file. That is genuinely
 * lost, and it is the real cost of this migration. In exchange the test now
 * exercises the same engine production uses instead of a different one.
 *
 * It runs only when `TEST_DATABASE_URL` is set — deliberately a *separate*
 * variable from `DATABASE_URL`, so a stray `npm test` can never point at a real
 * index. Every run gets its own randomly named schema, dropped afterwards, so
 * concurrent runs and a shared Neon database cannot collide.
 */

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeDb = TEST_DATABASE_URL ? describe : describe.skip;

const TEST_SCHEMA = `cda_test_${Math.random().toString(36).slice(2, 10)}`;

process.env.OPENAI_API_KEY = "test-key-not-used";
process.env.DATABASE_URL = TEST_DATABASE_URL ?? "postgres://unused";
process.env.DATABASE_SCHEMA = TEST_SCHEMA;
process.env.LOG_LEVEL = "error";

/**
 * Deterministic stand-in for a real embedding model: hash tokens into a
 * 1536-dimension bag-of-words vector and L2-normalise.
 *
 * Not semantic — it cannot match "authenticate" to "login" — but it is a
 * genuine vector space where lexical overlap produces higher cosine
 * similarity. Enough to prove the plumbing ranks correctly, and unlike a random
 * or constant vector it would actually catch an ordering bug.
 */
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

describeDb("postgres pipeline", () => {
  beforeAll(async () => {
    pipeline = await import("@/lib/ingest/pipeline");
    retrieval = await import("@/lib/retrieval");
    db = await import("@/lib/db");

    const started = await pipeline.startIngestion({
      sourceType: "upload",
      sourceRef: "demo-api",
      files: FIXTURE_FILES,
    });
    repoId = started.id;
    await started.done;
  }, 120_000);

  afterAll(async () => {
    // The schema is disposable and uniquely named, so this cannot touch
    // anything but the rows this file created.
    await db.query(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`).catch(() => undefined);
    await db.closeDb();
  });

  describe("ingestion", () => {
    it("finishes and marks the repository ready", async () => {
      const [repo] = await db.query<{
        status: string;
        file_count: number;
        chunk_count: number;
      }>(
        `SELECT status, file_count, chunk_count FROM ${db.tbl("repositories")} WHERE id = $1`,
        [repoId],
      );

      expect(repo.status).toBe("ready");
      expect(Number(repo.file_count)).toBe(5); // the two excluded fixtures are gone
      expect(Number(repo.chunk_count)).toBeGreaterThan(4);
    });

    it("excludes dependency and lockfile noise from the index", async () => {
      const rows = await db.query<{ path: string }>(
        `SELECT path FROM ${db.tbl("files")} WHERE repo_id = $1`,
        [repoId],
      );
      const paths = rows.map((r) => r.path);

      expect(paths).toContain("src/auth/session.ts");
      expect(paths.some((p) => p.includes("node_modules"))).toBe(false);
      expect(paths).not.toContain("package-lock.json");
    });

    it("strips the uploaded root folder from stored paths", async () => {
      const rows = await db.query<{ path: string }>(
        `SELECT path FROM ${db.tbl("files")} WHERE repo_id = $1`,
        [repoId],
      );
      expect(rows.every((r) => !r.path.startsWith("demo/"))).toBe(true);
    });

    it("writes an embedding for every chunk", async () => {
      const [counts] = await db.query<{ total: string; embedded: string }>(
        `SELECT COUNT(*) AS total,
                COUNT(embedding) AS embedded
           FROM ${db.tbl("chunks")} WHERE repo_id = $1`,
        [repoId],
      );
      expect(Number(counts.embedded)).toBe(Number(counts.total));
      expect(Number(counts.total)).toBeGreaterThan(0);
    });

    it("populates the generated tsvector column automatically", async () => {
      // No triggers to keep in sync — Postgres recomputes `search` on write,
      // so it cannot drift from embed_text the way the SQLite FTS index could.
      const [row] = await db.query<{ n: string }>(
        `SELECT COUNT(*) AS n
           FROM ${db.tbl("chunks")}, to_tsquery('simple', 'validatesession') AS q
          WHERE repo_id = $1 AND search @@ q`,
        [repoId],
      );
      expect(Number(row.n)).toBeGreaterThan(0);
    });

    it("builds a repo map with dependencies and routes", async () => {
      const [row] = await db.query<{ repo_map: Record<string, never> }>(
        `SELECT repo_map FROM ${db.tbl("repositories")} WHERE id = $1`,
        [repoId],
      );
      // jsonb round-trips as an object, not a string.
      const map = row.repo_map as unknown as {
        dependencies: Array<{ runtime: string[] }>;
        endpoints: Array<{ method: string; path: string }>;
        readmeExcerpt: string;
      };

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
      expect(result.stats.ftsQuery).toContain("validatesession");
    });

    it("routes a connection-pool question to the database module", async () => {
      const result = await retrieval.retrieve(
        repoId,
        "how is the postgres connection pool configured",
      );
      expect(result.chunks[0].filePath).toBe("src/db/connection.ts");
    });

    it("reports which retriever surfaced each chunk", async () => {
      const result = await retrieval.retrieve(repoId, "validateSession jwt verify");
      const vias = new Set(result.chunks.map((c) => c.via));
      expect([...vias].some((v) => v === "vector" || v === "keyword" || v === "both")).toBe(
        true,
      );
    });

    it("still answers when the keyword side finds nothing", async () => {
      // All stopwords — buildTsQuery returns null and retrieval must fall back
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
      const other = await pipeline.startIngestion({
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

      const [leaked] = await db.query<{ n: string }>(
        `SELECT COUNT(*) AS n FROM ${db.tbl("chunks")}
          WHERE repo_id <> $1 AND id = ANY($2::bigint[])`,
        [repoId, ids],
      );

      expect(Number(leaked.n)).toBe(0);

      await pipeline.deleteRepository(other.id);
    });
  });

  describe("deleteRepository", () => {
    it("cascades to files and chunks", async () => {
      const temp = await pipeline.startIngestion({
        sourceType: "upload",
        sourceRef: "throwaway",
        files: [{ path: "t/src/index.ts", content: "export const answer = 42;\n" }],
      });
      await temp.done;

      await pipeline.deleteRepository(temp.id);

      // Unlike the SQLite version there is no separate vector table to clean up
      // by hand — embeddings are a column, so ON DELETE CASCADE reaches them.
      for (const table of ["files", "chunks"]) {
        const [row] = await db.query<{ n: string }>(
          `SELECT COUNT(*) AS n FROM ${db.tbl(table)} WHERE repo_id = $1`,
          [temp.id],
        );
        expect(Number(row.n), table).toBe(0);
      }
    });

    it("reports whether a row was actually removed", async () => {
      const temp = await pipeline.startIngestion({
        sourceType: "upload",
        sourceRef: "throwaway-twice",
        files: [{ path: "t/src/index.ts", content: "export const answer = 42;\n" }],
      });
      await temp.done;

      expect(await pipeline.deleteRepository(temp.id)).toBe(true);
      // Idempotent: the route reports success either way, but the flag is what
      // lets it tell a real delete from a repeat.
      expect(await pipeline.deleteRepository(temp.id)).toBe(false);
    });

    /**
     * Deleting mid-ingest is the case the UI now allows, because a job killed
     * on serverless can leave a row stuck in `indexing` forever.
     *
     * The pipeline can be cancelled at two different points — a status
     * checkpoint, or a foreign-key violation if the delete lands inside the
     * file/chunk transaction — and which one wins is a race. So this asserts
     * the outcome both paths must produce rather than the path taken: the
     * background job unwinds quietly, and nothing is left behind.
     */
    it("cancels an in-flight ingestion rather than resurrecting it", async () => {
      const temp = await pipeline.startIngestion({
        sourceType: "upload",
        sourceRef: "deleted-mid-flight",
        files: FIXTURE_FILES,
      });

      await pipeline.deleteRepository(temp.id);

      // Must resolve, not reject: a deleted repository is a normal outcome, so
      // it has to unwind without an unhandled rejection taking the process down.
      await expect(temp.done).resolves.toBeUndefined();

      // In particular the row must not come back as `failed` — `markFailed`
      // would be writing a status for something the user deliberately removed.
      for (const table of ["repositories", "files", "chunks"]) {
        const column = table === "repositories" ? "id" : "repo_id";
        const [row] = await db.query<{ n: string }>(
          `SELECT COUNT(*) AS n FROM ${db.tbl(table)} WHERE ${column} = $1`,
          [temp.id],
        );
        expect(Number(row.n), table).toBe(0);
      }
    }, 120_000);
  });
});
