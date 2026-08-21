import "server-only";

import { nanoid } from "nanoid";

import { getDb, toVectorBlob, type DB } from "@/lib/db";
import { embedTexts } from "@/lib/embeddings";
import { logger } from "@/lib/observability/logger";
import { chunkFile, type CodeChunk } from "./chunker";
import { detectLanguage } from "./languages";
import { buildRepoMap } from "./repo-map";
import {
  IngestError,
  loadGitHubRepo,
  loadUploadedFiles,
  type LoadedSource,
} from "./sources";

export interface StartIngestionInput {
  sourceType: "github" | "upload";
  /** GitHub URL, or a display name for an upload. */
  sourceRef: string;
  files?: Array<{ path: string; content: string }>;
}

/**
 * Create the repository row and kick off indexing.
 *
 * Indexing runs detached rather than awaited: a mid-size repo takes 30-90
 * seconds, which is far past any sensible HTTP timeout, and holding the
 * request open gives the user a spinner with no detail. Instead the row is
 * created immediately in `queued` state and progress is written to the same
 * row as work proceeds, so the client can poll a real percentage.
 *
 * This is the single biggest thing I'd change for production — see the README:
 * an in-process background task dies with the process and cannot be retried or
 * observed across replicas. It wants a real queue.
 */
export interface StartedIngestion {
  id: string;
  /**
   * Resolves when indexing finishes. The HTTP route ignores it — the client
   * polls instead — but tests and scripts need a way to await completion
   * without sleeping and hoping.
   */
  done: Promise<void>;
}

export function startIngestion(input: StartIngestionInput): StartedIngestion {
  const db = getDb();
  const id = nanoid(12);
  const now = Date.now();

  const displayName =
    input.sourceType === "github"
      ? input.sourceRef.replace(/^https?:\/\/(www\.)?github\.com\//, "").replace(/\/$/, "")
      : input.sourceRef;

  db.prepare(
    `INSERT INTO repositories (id, name, source_type, source_ref, status, status_detail, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'queued', 'Queued', ?, ?)`,
  ).run(id, displayName, input.sourceType, input.sourceRef, now, now);

  const done = runIngestion(id, input).catch((error) => {
    logger.error("ingestion failed", error, { repoId: id });
    const message =
      error instanceof IngestError
        ? error.message
        : "Indexing failed unexpectedly. Check server logs.";
    markFailed(db, id, message);
  });

  return { id, done };
}

async function runIngestion(repoId: string, input: StartIngestionInput): Promise<void> {
  const db = getDb();
  const log = logger.bind({ repoId });
  const started = performance.now();

  setStatus(db, repoId, "indexing", "Downloading source", 0.02);

  const source: LoadedSource =
    input.sourceType === "github"
      ? await loadGitHubRepo(input.sourceRef)
      : loadUploadedFiles(input.sourceRef, input.files ?? []);

  setStatus(db, repoId, "indexing", `Chunking ${source.files.length} files`, 0.12);

  // ---- Files + chunks -----------------------------------------------------
  const insertFile = db.prepare(
    `INSERT INTO files (repo_id, path, language, bytes, loc, content) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const insertChunk = db.prepare(
    `INSERT INTO chunks (repo_id, file_id, ordinal, start_line, end_line, symbol, kind, token_count, content, embed_text)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  interface PendingChunk {
    id: number;
    embedText: string;
  }
  const pending: PendingChunk[] = [];

  // One transaction for all metadata: better-sqlite3 is synchronous, and
  // committing per row would fsync thousands of times.
  const writeAll = db.transaction(() => {
    for (const file of source.files) {
      const spec = detectLanguage(file.path);
      if (!spec) continue;

      const chunks: CodeChunk[] = chunkFile(file.path, file.content);
      if (chunks.length === 0) continue;

      const fileResult = insertFile.run(
        repoId,
        file.path,
        spec.language,
        file.bytes,
        file.content.split("\n").length,
        file.content,
      );
      const fileId = Number(fileResult.lastInsertRowid);

      for (const chunk of chunks) {
        const chunkResult = insertChunk.run(
          repoId,
          fileId,
          chunk.ordinal,
          chunk.startLine,
          chunk.endLine,
          chunk.symbol,
          chunk.kind,
          chunk.tokenCount,
          chunk.content,
          chunk.embedText,
        );
        pending.push({
          id: Number(chunkResult.lastInsertRowid),
          embedText: chunk.embedText,
        });
      }
    }
  });
  writeAll();

  log.info("chunked", { files: source.files.length, chunks: pending.length });
  setStatus(db, repoId, "indexing", `Embedding ${pending.length} chunks`, 0.2);

  // ---- Embeddings ---------------------------------------------------------
  const insertVector = db.prepare(
    `INSERT INTO chunk_vectors (chunk_id, repo_id, embedding) VALUES (?, ?, ?)`,
  );

  const EMBED_WINDOW = 384; // ~4 API batches per progress tick
  let embedTokens = 0;

  for (let offset = 0; offset < pending.length; offset += EMBED_WINDOW) {
    const window = pending.slice(offset, offset + EMBED_WINDOW);
    const { vectors, tokens } = await embedTexts(window.map((c) => c.embedText));
    embedTokens += tokens;

    db.transaction(() => {
      for (let i = 0; i < window.length; i++) {
        // vec0 requires an INTEGER rowid; better-sqlite3 binds plain JS
        // numbers as REAL, which the extension rejects. BigInt forces INTEGER.
        insertVector.run(BigInt(window[i].id), repoId, toVectorBlob(vectors[i]));
      }
    })();

    const done = Math.min(offset + window.length, pending.length);
    setStatus(
      db,
      repoId,
      "indexing",
      `Embedded ${done} / ${pending.length} chunks`,
      0.2 + 0.75 * (done / pending.length),
    );
  }

  // ---- Repo map -----------------------------------------------------------
  setStatus(db, repoId, "indexing", "Analysing structure", 0.97);
  const repoMap = buildRepoMap(source.files);

  db.prepare(
    `UPDATE repositories
     SET status = 'ready', status_detail = ?, progress = 1, commit_ref = ?,
         file_count = ?, chunk_count = ?, embed_tokens = ?, repo_map = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    `Indexed ${source.files.length} files`,
    source.ref,
    source.files.length,
    pending.length,
    embedTokens,
    JSON.stringify(repoMap),
    Date.now(),
    repoId,
  );

  log.info("ingestion complete", {
    files: source.files.length,
    chunks: pending.length,
    embedTokens,
    endpoints: repoMap.endpoints.length,
    durationMs: Math.round(performance.now() - started),
  });
}

function setStatus(
  db: DB,
  repoId: string,
  status: string,
  detail: string,
  progress: number,
) {
  db.prepare(
    `UPDATE repositories SET status = ?, status_detail = ?, progress = ?, updated_at = ? WHERE id = ?`,
  ).run(status, detail, progress, Date.now(), repoId);
}

function markFailed(db: DB, repoId: string, detail: string) {
  try {
    db.prepare(
      `UPDATE repositories SET status = 'failed', status_detail = ?, updated_at = ? WHERE id = ?`,
    ).run(detail, Date.now(), repoId);
  } catch (error) {
    logger.error("could not mark repository failed", error, { repoId });
  }
}

export function deleteRepository(repoId: string): void {
  const db = getDb();
  db.transaction(() => {
    // chunk_vectors is a virtual table, so ON DELETE CASCADE does not reach it.
    db.prepare("DELETE FROM chunk_vectors WHERE repo_id = ?").run(repoId);
    db.prepare("DELETE FROM repositories WHERE id = ?").run(repoId);
  })();
  logger.info("repository deleted", { repoId });
}
