import "server-only";

import { Pool, type PoolClient, type QueryResultRow } from "pg";

import { embeddingDimensions, env } from "@/lib/config";
import { logger } from "@/lib/observability/logger";
import { schemaSql } from "./schema";

/**
 * Postgres connection pool.
 *
 * ## Pool sizing is a deployment concern
 * Every serverless instance builds its own pool, and node-postgres defaults
 * `max` to 10 — which quietly reserves ten connections per instance for
 * sockets that are idle almost all the time. Three is plenty here: requests in
 * this app spend seconds waiting on OpenAI and milliseconds waiting on
 * Postgres, so concurrency is bounded by the model, not the database.
 *
 * This is only safe against Neon's **pooled** endpoint (host contains
 * `-pooler`). The direct endpoint has a hard connection ceiling that
 * N instances x 3 will find.
 *
 * `connectionTimeoutMillis` matters more than it looks: the default is 0,
 * meaning "wait forever" for a free connection. On a metered function that is
 * a request which bills for its whole duration and then times out with nothing
 * to show. Fail fast instead.
 */
const GLOBAL_KEY = Symbol.for("code-docs-assistant.pg");
type GlobalWithPool = typeof globalThis & {
  [GLOBAL_KEY]?: { pool: Pool; ready: Promise<void> };
};

function createPool(): Pool {
  const pool = new Pool({
    connectionString: env().DATABASE_URL,
    max: 3,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    // Neon requires TLS. `pg` will not enable it from the URL alone unless
    // sslmode is present, so this is belt and braces for both forms.
    ssl: env().DATABASE_URL.includes("localhost") ? undefined : { rejectUnauthorized: true },
  });

  // NOTE: deliberately no `pool.on("connect")` session setup.
  //
  // The obvious place to run `SET search_path` and the HNSW tuning is a connect
  // handler, and it is wrong: `connect` is a plain event, so the pool cannot
  // await it. It hands the client to the caller while those statements are
  // still in flight, which node-postgres reports as "Calling client.query()
  // when the client is already executing a query" — deprecated today, an error
  // in pg 9.
  //
  // Neither setting is needed there anyway:
  //   * search_path — every table reference goes through `tbl()`, which is
  //     schema-qualified, and the `vector` type lives in `public`, which is on
  //     the default search path already.
  //   * hnsw.*      — scoped to the one query that needs it, with `SET LOCAL`
  //     inside a transaction. See `retrieval/index.ts`.

  // An idle client erroring (Neon scaling to zero, a network blip) emits on the
  // pool. Unhandled, it takes the process down.
  pool.on("error", (error) => {
    logger.error("idle postgres client error", error);
  });

  return pool;
}

/**
 * Returns a pool with the schema guaranteed to exist.
 *
 * Bootstrapping is memoised as a promise rather than a boolean so that N
 * concurrent first-requests await one migration instead of racing to run it
 * N times.
 */
export function getDb(): Promise<Pool> {
  const cached = (globalThis as GlobalWithPool)[GLOBAL_KEY];
  if (cached) return cached.ready.then(() => cached.pool);

  const pool = createPool();
  const ready = bootstrap(pool);
  (globalThis as GlobalWithPool)[GLOBAL_KEY] = { pool, ready };
  return ready.then(() => pool);
}

/**
 * Serialise schema creation across every process touching this database.
 *
 * `IF NOT EXISTS` reads as concurrency-safe and is not: Postgres checks, then
 * creates, without holding a lock between the two. Two callers that both find
 * the extension missing will both try to create it, and one gets
 * `duplicate key value violates unique constraint "pg_extension_name_index"`.
 * Two Vitest workers found this immediately; N serverless instances cold-
 * starting against a fresh database would find it in production.
 *
 * `pg_advisory_xact_lock` rather than the session-level `pg_advisory_lock`,
 * because the recommended Neon endpoint is the PgBouncer pooler running in
 * transaction mode — where a session-scoped lock may be taken on one backend
 * and released on another. Transaction-scoped locks are released at COMMIT,
 * which is exactly the guarantee transaction pooling preserves.
 *
 * The key is derived from the schema name so two schemas can bootstrap in
 * parallel without blocking each other.
 */
function advisoryLockKey(schema: string): number {
  // FNV-1a, 32-bit. `pg_advisory_xact_lock` takes a bigint, but a 32-bit key is
  // ample: the only cost of a collision is that two *different* schemas would
  // serialise their bootstraps behind each other, which is a few milliseconds
  // once per process — not a correctness problem.
  const input = `code-docs-assistant:${schema}`;
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  // `|0` keeps it a signed 32-bit integer, comfortably inside bigint range.
  return hash | 0;
}

/** Run `fn` in a transaction holding the schema's bootstrap lock. */
async function withSchemaLock<T>(
  pool: Pool,
  schema: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [advisoryLockKey(schema)]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function bootstrap(pool: Pool): Promise<void> {
  const schema = env().DATABASE_SCHEMA;
  const model = env().OPENAI_EMBEDDING_MODEL;
  const dims = embeddingDimensions(model);

  // The whole bootstrap — create, inspect, possibly rebuild, record — runs
  // under one lock. Splitting it would reopen the race in the rebuild branch:
  // two instances could both read the old model, both drop `chunks`, and the
  // second would drop the table the first had just repopulated.
  //
  // DDL is transactional in Postgres, so this applies whole or not at all.
  const pgvector = await withSchemaLock(pool, schema, async (client) => {
    await client.query(schemaSql());

    // If the embedding model changed, every stored vector is meaningless —
    // vectors from different models live in unrelated coordinate spaces, so
    // cosine distance between them still sorts, still looks plausible, and is
    // entirely garbage. Drop the rows rather than serve nonsense neighbours.
    const meta = await client.query<{ model: string; dimensions: number }>(
      `SELECT model, dimensions FROM "${schema}".vector_meta WHERE id = 1`,
    );
    const previous = meta.rows[0];

    if (previous && previous.dimensions !== dims) {
      logger.warn("embedding model changed — rebuilding vector index", {
        from: previous.model,
        to: model,
      });
      await client.query(`DROP TABLE IF EXISTS "${schema}".chunks CASCADE`);
      await client.query(
        `UPDATE "${schema}".repositories
            SET status = 'failed',
                status_detail = 'Embedding model changed — re-index required'`,
      );
      await client.query(schemaSql());
    }

    await client.query(
      `INSERT INTO "${schema}".vector_meta (id, model, dimensions) VALUES (1, $1, $2)
       ON CONFLICT (id) DO UPDATE SET model = EXCLUDED.model, dimensions = EXCLUDED.dimensions`,
      [model, dims],
    );

    const version = await client.query<{ v: string }>(
      "SELECT extversion AS v FROM pg_extension WHERE extname = 'vector'",
    );
    return version.rows[0]?.v ?? "unknown";
  });

  logger.info("database ready", { schema, pgvector });
}

/** Convenience wrapper so callers do not repeat `(await getDb()).query(...)`. */
export async function query<T extends QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const pool = await getDb();
  const result = await pool.query<T>(text, params);
  return result.rows;
}

/**
 * Run a function inside a transaction, releasing the client either way.
 *
 * Ingestion writes thousands of rows; without a transaction each INSERT is its
 * own round trip *and* its own commit, which against a hosted database an ocean
 * away is the difference between seconds and minutes.
 */
export async function transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const pool = await getDb();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * pgvector accepts its input as the text form `[0.1,0.2,...]` and casts.
 * There is no binary protocol for it in `pg`, so this is the representation on
 * both the write and read paths.
 */
export function toVectorLiteral(values: number[]): string {
  return `[${values.join(",")}]`;
}

/** Schema-qualified table name for use in SQL templates. */
export function tbl(name: string): string {
  return `"${env().DATABASE_SCHEMA}".${name}`;
}

/** Closes the pool. Used by scripts and tests so the process can exit. */
export async function closeDb(): Promise<void> {
  const cached = (globalThis as GlobalWithPool)[GLOBAL_KEY];
  if (!cached) return;
  delete (globalThis as GlobalWithPool)[GLOBAL_KEY];
  await cached.pool.end();
}
