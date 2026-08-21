import "server-only";

import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

import { embeddingDimensions, env } from "@/lib/config";
import { logger } from "@/lib/observability/logger";
import { SCHEMA_SQL } from "./schema";

export type DB = Database.Database;

let instance: DB | null = null;

/**
 * Process-wide singleton. Next.js dev mode re-evaluates modules on every hot
 * reload, so the handle is parked on `globalThis` to avoid leaking file
 * descriptors and re-running migrations on every save.
 */
const GLOBAL_KEY = Symbol.for("code-docs-assistant.db");
type GlobalWithDb = typeof globalThis & { [GLOBAL_KEY]?: DB };

export function getDb(): DB {
  if (instance) return instance;

  const cached = (globalThis as GlobalWithDb)[GLOBAL_KEY];
  if (cached) {
    instance = cached;
    return instance;
  }

  const dbPath = env().DATABASE_PATH;
  fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });

  const db = new Database(dbPath);

  // WAL lets the ingestion writer and query readers proceed concurrently,
  // which matters because indexing runs in the background while the user is
  // already asking questions about an earlier repo.
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");

  sqliteVec.load(db);
  db.exec(SCHEMA_SQL);
  ensureVectorTable(db);

  logger.info("database ready", {
    path: dbPath,
    sqliteVec: (db.prepare("select vec_version() as v").get() as { v: string }).v,
  });

  instance = db;
  (globalThis as GlobalWithDb)[GLOBAL_KEY] = db;
  return db;
}

/**
 * The vector table is created here rather than in SCHEMA_SQL because its
 * dimensionality depends on the configured embedding model.
 *
 * If the configured model changes, the existing index is meaningless — vectors
 * from different models are not comparable — so we drop and rebuild rather
 * than silently returning nonsense neighbours. Repos then need re-indexing,
 * which is the honest outcome; `dimensions` is recorded to detect the change.
 */
function ensureVectorTable(db: DB) {
  const dims = embeddingDimensions(env().OPENAI_EMBEDDING_MODEL);

  db.exec(`CREATE TABLE IF NOT EXISTS vector_meta (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    model TEXT NOT NULL,
    dimensions INTEGER NOT NULL
  )`);

  const meta = db
    .prepare("SELECT model, dimensions FROM vector_meta WHERE id = 1")
    .get() as { model: string; dimensions: number } | undefined;

  if (meta && meta.dimensions !== dims) {
    logger.warn("embedding model changed — rebuilding vector index", {
      from: meta.model,
      to: env().OPENAI_EMBEDDING_MODEL,
    });
    db.exec("DROP TABLE IF EXISTS chunk_vectors");
    db.exec("DELETE FROM chunks");
    db.exec("UPDATE repositories SET status = 'failed', status_detail = 'Embedding model changed — re-index required'");
  }

  // `repo_id` as a partition key means KNN is evaluated inside a single repo's
  // vectors instead of globally, so one large repo can't crowd out results
  // from the repo the user is actually asking about.
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS chunk_vectors USING vec0(
    chunk_id INTEGER PRIMARY KEY,
    repo_id TEXT PARTITION KEY,
    embedding FLOAT[${dims}] DISTANCE_METRIC=cosine
  )`);

  db.prepare(
    "INSERT INTO vector_meta (id, model, dimensions) VALUES (1, ?, ?) " +
      "ON CONFLICT(id) DO UPDATE SET model = excluded.model, dimensions = excluded.dimensions",
  ).run(env().OPENAI_EMBEDDING_MODEL, dims);
}

/** better-sqlite3 binds JS numbers as REAL; vec0 rejects that for rowids. */
export function toVectorBlob(values: number[] | Float32Array): Buffer {
  const f32 = values instanceof Float32Array ? values : Float32Array.from(values);
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
}
