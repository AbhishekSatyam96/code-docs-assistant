/**
 * Schema as a TypeScript module rather than a .sql file read at runtime:
 * Next.js standalone builds only trace JS, so a loose .sql asset would be
 * missing in the container. Keeping it here means the build is self-contained.
 */
export const SCHEMA_SQL = `
-- ---------------------------------------------------------------------------
-- Repositories
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS repositories (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  source_type   TEXT NOT NULL CHECK (source_type IN ('github', 'upload')),
  source_ref    TEXT NOT NULL,
  commit_ref    TEXT,
  status        TEXT NOT NULL CHECK (status IN ('queued', 'indexing', 'ready', 'failed')),
  status_detail TEXT,
  progress      REAL NOT NULL DEFAULT 0,
  file_count    INTEGER NOT NULL DEFAULT 0,
  chunk_count   INTEGER NOT NULL DEFAULT 0,
  embed_tokens  INTEGER NOT NULL DEFAULT 0,
  repo_map      TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- Files. Full contents are retained so citations can be rendered with real
-- surrounding code rather than just the retrieved slice.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS files (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id  TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  path     TEXT NOT NULL,
  language TEXT NOT NULL,
  bytes    INTEGER NOT NULL,
  loc      INTEGER NOT NULL,
  content  TEXT NOT NULL,
  UNIQUE (repo_id, path)
);

CREATE INDEX IF NOT EXISTS idx_files_repo ON files (repo_id);

-- ---------------------------------------------------------------------------
-- Chunks. \`content\` is the verbatim source slice shown to the user;
-- \`embed_text\` is the contextualised form (path/symbol header + content) that
-- was actually embedded and indexed for keyword search.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS chunks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id     TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  file_id     INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  ordinal     INTEGER NOT NULL,
  start_line  INTEGER NOT NULL,
  end_line    INTEGER NOT NULL,
  symbol      TEXT,
  kind        TEXT NOT NULL,
  token_count INTEGER NOT NULL,
  content     TEXT NOT NULL,
  embed_text  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chunks_repo ON chunks (repo_id);
CREATE INDEX IF NOT EXISTS idx_chunks_file_ordinal ON chunks (file_id, ordinal);

-- ---------------------------------------------------------------------------
-- Keyword half of hybrid retrieval.
--
-- \`tokenchars\` keeps \`_\`, \`$\` and \`.\` inside tokens, so \`handleRequest\`,
-- \`$scope\` and \`res.status\` survive tokenisation instead of being shredded
-- into meaningless fragments. This matters enormously for code, where the
-- user's query is very often a literal identifier.
--
-- External-content FTS5 (content='chunks') avoids storing a second copy of
-- every chunk; the triggers below keep the index in sync.
-- ---------------------------------------------------------------------------
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  embed_text,
  content='chunks',
  content_rowid='id',
  tokenize="unicode61 remove_diacritics 2 tokenchars '_$.'"
);

CREATE TRIGGER IF NOT EXISTS chunks_fts_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, embed_text) VALUES (new.id, new.embed_text);
END;

CREATE TRIGGER IF NOT EXISTS chunks_fts_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, embed_text) VALUES ('delete', old.id, old.embed_text);
END;

CREATE TRIGGER IF NOT EXISTS chunks_fts_au AFTER UPDATE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, embed_text) VALUES ('delete', old.id, old.embed_text);
  INSERT INTO chunks_fts(rowid, embed_text) VALUES (new.id, new.embed_text);
END;

-- ---------------------------------------------------------------------------
-- Observability: one row per answered question.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS traces (
  id                TEXT PRIMARY KEY,
  repo_id           TEXT,
  question          TEXT NOT NULL,
  resolved_question TEXT,
  intent            TEXT,
  status            TEXT NOT NULL,
  refusal_reason    TEXT,
  retrieved         TEXT,
  retrieval_ms      INTEGER NOT NULL DEFAULT 0,
  embed_ms          INTEGER NOT NULL DEFAULT 0,
  llm_ms            INTEGER NOT NULL DEFAULT 0,
  total_ms          INTEGER NOT NULL DEFAULT 0,
  prompt_tokens     INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd          REAL NOT NULL DEFAULT 0,
  model             TEXT,
  created_at        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_traces_created ON traces (created_at DESC);
`;
