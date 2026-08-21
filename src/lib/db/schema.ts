import { embeddingDimensions, env } from "@/lib/config";

/**
 * Schema as SQL text applied on first connection, rather than a migration tool.
 *
 * This app has one schema owner and no rollback story worth speaking of — every
 * statement is `IF NOT EXISTS`, so applying it repeatedly is a no-op. A real
 * migration chain (and the `prisma migrate deploy` discipline in the sibling
 * rag-assistant project) is the right answer once a second developer or a
 * second environment exists; the README says so under productionising.
 *
 * Everything lives in its own Postgres schema so this app can share a Neon
 * database with something else without either owning `public`.
 */
export function schemaSql(): string {
  const dims = embeddingDimensions(env().OPENAI_EMBEDDING_MODEL);
  const s = env().DATABASE_SCHEMA;

  return `
CREATE SCHEMA IF NOT EXISTS "${s}";

-- The extension is database-wide and conventionally lives in public. Creating
-- it is idempotent, and search_path (set per connection) makes the 'vector'
-- type resolvable from our schema.
CREATE EXTENSION IF NOT EXISTS vector;

-- ---------------------------------------------------------------------------
-- Repositories
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "${s}".repositories (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  source_type   TEXT NOT NULL CHECK (source_type IN ('github', 'upload')),
  source_ref    TEXT NOT NULL,
  commit_ref    TEXT,
  status        TEXT NOT NULL CHECK (status IN ('queued', 'indexing', 'ready', 'failed')),
  status_detail TEXT,
  progress      DOUBLE PRECISION NOT NULL DEFAULT 0,
  file_count    INTEGER NOT NULL DEFAULT 0,
  chunk_count   INTEGER NOT NULL DEFAULT 0,
  embed_tokens  BIGINT NOT NULL DEFAULT 0,
  repo_map      JSONB,
  created_at    BIGINT NOT NULL,
  updated_at    BIGINT NOT NULL
);

-- ---------------------------------------------------------------------------
-- Files. Full contents are retained so citations render with real surrounding
-- code rather than just the retrieved slice.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "${s}".files (
  id       BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  repo_id  TEXT NOT NULL REFERENCES "${s}".repositories(id) ON DELETE CASCADE,
  path     TEXT NOT NULL,
  language TEXT NOT NULL,
  bytes    INTEGER NOT NULL,
  loc      INTEGER NOT NULL,
  content  TEXT NOT NULL,
  UNIQUE (repo_id, path)
);

CREATE INDEX IF NOT EXISTS files_repo_idx ON "${s}".files (repo_id);

-- ---------------------------------------------------------------------------
-- Chunks.
--
-- 'content' is the verbatim source slice shown to the user; 'embed_text' is the
-- contextualised form (path/symbol header + content) that was embedded and is
-- indexed for keyword search.
--
-- 'search' is a STORED generated column rather than a trigger-maintained one:
-- Postgres recomputes it on write and it can never drift from 'embed_text',
-- which is exactly the failure the SQLite version needed three triggers to
-- avoid.
--
-- The 'simple' text search configuration is deliberate. 'english' stems and
-- strips stopwords, which is right for prose and wrong for code: it would turn
-- 'parsing'/'parser'/'parse' into one token and discard 'in', 'to', 'not' —
-- all of which are real identifiers. 'simple' just lowercases, and the query
-- builder in retrieval/fts-query.ts already removes stopwords and splits
-- camelCase itself.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "${s}".chunks (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  repo_id     TEXT NOT NULL REFERENCES "${s}".repositories(id) ON DELETE CASCADE,
  file_id     BIGINT NOT NULL REFERENCES "${s}".files(id) ON DELETE CASCADE,
  ordinal     INTEGER NOT NULL,
  start_line  INTEGER NOT NULL,
  end_line    INTEGER NOT NULL,
  symbol      TEXT,
  kind        TEXT NOT NULL,
  token_count INTEGER NOT NULL,
  content     TEXT NOT NULL,
  embed_text  TEXT NOT NULL,
  embedding   vector(${dims}),
  search      tsvector GENERATED ALWAYS AS (to_tsvector('simple', embed_text)) STORED
);

CREATE INDEX IF NOT EXISTS chunks_repo_idx ON "${s}".chunks (repo_id);
CREATE INDEX IF NOT EXISTS chunks_file_ordinal_idx ON "${s}".chunks (file_id, ordinal);
CREATE INDEX IF NOT EXISTS chunks_search_idx ON "${s}".chunks USING GIN (search);

-- The vector index.
--
-- HNSW rather than IVFFlat: IVFFlat learns cluster centroids from existing
-- data, so building it on an empty table produces a permanently bad index.
-- This table starts empty and grows one repository at a time, so HNSW's
-- incremental build is the only sane option.
--
-- 'vector_cosine_ops' is load-bearing: it pairs with the <=> operator used in
-- retrieval. Querying with <-> (L2) or <#> (inner product) does not error —
-- Postgres silently ignores the index and sequential-scans every row, which
-- fails as "correct but slow", the kind of bug that survives to production.
CREATE INDEX IF NOT EXISTS chunks_embedding_hnsw_idx
  ON "${s}".chunks USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- ---------------------------------------------------------------------------
-- Observability: one row per answered question.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "${s}".traces (
  id                TEXT PRIMARY KEY,
  repo_id           TEXT,
  question          TEXT NOT NULL,
  resolved_question TEXT,
  intent            TEXT,
  status            TEXT NOT NULL,
  refusal_reason    TEXT,
  retrieved         JSONB,
  retrieval_ms      INTEGER NOT NULL DEFAULT 0,
  embed_ms          INTEGER NOT NULL DEFAULT 0,
  llm_ms            INTEGER NOT NULL DEFAULT 0,
  total_ms          INTEGER NOT NULL DEFAULT 0,
  prompt_tokens     INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd          DOUBLE PRECISION NOT NULL DEFAULT 0,
  model             TEXT,
  created_at        BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS traces_created_idx ON "${s}".traces (created_at DESC);

-- Records which embedding model built the index. Vectors from different models
-- are not comparable, so a change here invalidates everything.
CREATE TABLE IF NOT EXISTS "${s}".vector_meta (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  model      TEXT NOT NULL,
  dimensions INTEGER NOT NULL
);
`;
}
