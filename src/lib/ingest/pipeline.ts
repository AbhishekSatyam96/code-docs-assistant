import "server-only";

import { nanoid } from "nanoid";
import type { PoolClient } from "pg";

import { query, tbl, toVectorLiteral, transaction } from "@/lib/db";
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

export interface StartedIngestion {
  id: string;
  /**
   * Resolves when indexing finishes. The HTTP route ignores it — the client
   * polls instead — but tests and scripts need a way to await completion
   * without sleeping and hoping.
   */
  done: Promise<void>;
}

/**
 * Create the repository row and kick off indexing.
 *
 * Indexing runs detached rather than awaited: a mid-size repo takes 30-90
 * seconds, far past any sensible HTTP timeout, and holding the request open
 * gives the user a spinner with no detail. The row is created immediately in
 * `queued` state and progress is written to it as work proceeds, so the client
 * can poll a real percentage.
 *
 * This is the single biggest thing to change for production — see the README.
 * An in-process background task dies with the process, cannot be retried, and
 * cannot be observed across replicas. On a serverless host it is worse than
 * that: the instance is frozen once the response is sent, so indexing would be
 * killed mid-flight. It wants a real queue.
 */
export async function startIngestion(
  input: StartIngestionInput,
): Promise<StartedIngestion> {
  const id = nanoid(12);
  const now = Date.now();

  const displayName =
    input.sourceType === "github"
      ? input.sourceRef.replace(/^https?:\/\/(www\.)?github\.com\//, "").replace(/\/$/, "")
      : input.sourceRef;

  await query(
    `INSERT INTO ${tbl("repositories")}
       (id, name, source_type, source_ref, status, status_detail, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'queued', 'Queued', $5, $6)`,
    [id, displayName, input.sourceType, input.sourceRef, now, now],
  );

  const done = runIngestion(id, input).catch(async (error) => {
    logger.error("ingestion failed", error, { repoId: id });
    const message =
      error instanceof IngestError
        ? error.message
        : "Indexing failed unexpectedly. Check server logs.";
    await markFailed(id, message);
  });

  return { id, done };
}

async function runIngestion(repoId: string, input: StartIngestionInput): Promise<void> {
  const log = logger.bind({ repoId });
  const started = performance.now();

  await setStatus(repoId, "indexing", "Downloading source", 0.02);

  const source: LoadedSource =
    input.sourceType === "github"
      ? await loadGitHubRepo(input.sourceRef)
      : loadUploadedFiles(input.sourceRef, input.files ?? []);

  await setStatus(repoId, "indexing", `Chunking ${source.files.length} files`, 0.12);

  // ---- Files + chunks -----------------------------------------------------
  interface PendingChunk {
    id: number;
    embedText: string;
  }
  const pending: PendingChunk[] = [];

  await transaction(async (client) => {
    for (const file of source.files) {
      const spec = detectLanguage(file.path);
      if (!spec) continue;

      const chunks: CodeChunk[] = chunkFile(file.path, file.content);
      if (chunks.length === 0) continue;

      const fileResult = await client.query<{ id: string }>(
        `INSERT INTO ${tbl("files")} (repo_id, path, language, bytes, loc, content)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [
          repoId,
          file.path,
          spec.language,
          file.bytes,
          file.content.split("\n").length,
          file.content,
        ],
      );
      const fileId = Number(fileResult.rows[0].id);

      const ids = await insertChunkBatch(client, repoId, fileId, chunks);
      chunks.forEach((chunk, index) => {
        pending.push({ id: ids[index], embedText: chunk.embedText });
      });
    }
  });

  log.info("chunked", { files: source.files.length, chunks: pending.length });
  await setStatus(repoId, "indexing", `Embedding ${pending.length} chunks`, 0.2);

  // ---- Embeddings ---------------------------------------------------------
  const EMBED_WINDOW = 384; // ~4 API batches per progress tick
  let embedTokens = 0;

  for (let offset = 0; offset < pending.length; offset += EMBED_WINDOW) {
    const window = pending.slice(offset, offset + EMBED_WINDOW);
    const { vectors, tokens } = await embedTexts(window.map((c) => c.embedText));
    embedTokens += tokens;

    await writeEmbeddings(
      window.map((chunk, index) => ({ id: chunk.id, vector: vectors[index] })),
    );

    const done = Math.min(offset + window.length, pending.length);
    await setStatus(
      repoId,
      "indexing",
      `Embedded ${done} / ${pending.length} chunks`,
      0.2 + 0.75 * (done / pending.length),
    );
  }

  // ---- Repo map -----------------------------------------------------------
  await setStatus(repoId, "indexing", "Analysing structure", 0.97);
  const repoMap = buildRepoMap(source.files);

  await query(
    `UPDATE ${tbl("repositories")}
        SET status = 'ready', status_detail = $1, progress = 1, commit_ref = $2,
            file_count = $3, chunk_count = $4, embed_tokens = $5,
            repo_map = $6::jsonb, updated_at = $7
      WHERE id = $8`,
    [
      `Indexed ${source.files.length} files`,
      source.ref,
      source.files.length,
      pending.length,
      embedTokens,
      JSON.stringify(repoMap),
      Date.now(),
      repoId,
    ],
  );

  log.info("ingestion complete", {
    files: source.files.length,
    chunks: pending.length,
    embedTokens,
    endpoints: repoMap.endpoints.length,
    durationMs: Math.round(performance.now() - started),
  });
}

/**
 * Insert a file's chunks in one statement.
 *
 * The SQLite version could afford a prepared statement per row because it was
 * an in-process function call. Against a hosted database that is one network
 * round trip per chunk — on a 3,000-chunk repo, tens of thousands of
 * milliseconds spent entirely on latency. A multi-row VALUES list collapses it
 * to one round trip per file, and `RETURNING id` preserves the mapping from
 * row back to chunk so the embedding step knows what to attach where.
 */
async function insertChunkBatch(
  client: PoolClient,
  repoId: string,
  fileId: number,
  chunks: CodeChunk[],
): Promise<number[]> {
  const COLUMNS = 10;
  const params: unknown[] = [];
  const rows: string[] = [];

  chunks.forEach((chunk, index) => {
    const base = index * COLUMNS;
    rows.push(
      `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, ` +
        `$${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10})`,
    );
    params.push(
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
  });

  const result = await client.query<{ id: string }>(
    `INSERT INTO ${tbl("chunks")}
       (repo_id, file_id, ordinal, start_line, end_line, symbol, kind, token_count, content, embed_text)
     VALUES ${rows.join(", ")}
     RETURNING id`,
    params,
  );

  // Postgres returns RETURNING rows in insertion order for a multi-row VALUES
  // list, which is what lets us zip these back onto `chunks` by position.
  return result.rows.map((row) => Number(row.id));
}

/**
 * Attach embeddings to already-inserted chunks.
 *
 * `UPDATE ... FROM (VALUES ...)` rather than one UPDATE per chunk, for the same
 * round-trip reason as the insert above. The vectors are passed as bind
 * parameters and cast, never interpolated.
 */
async function writeEmbeddings(
  entries: Array<{ id: number; vector: number[] }>,
): Promise<void> {
  if (entries.length === 0) return;

  const params: unknown[] = [];
  const rows: string[] = [];

  entries.forEach((entry, index) => {
    const base = index * 2;
    rows.push(`($${base + 1}::bigint, $${base + 2}::vector)`);
    params.push(entry.id, toVectorLiteral(entry.vector));
  });

  await query(
    `UPDATE ${tbl("chunks")} AS c
        SET embedding = v.embedding
       FROM (VALUES ${rows.join(", ")}) AS v(id, embedding)
      WHERE c.id = v.id`,
    params,
  );
}

async function setStatus(
  repoId: string,
  status: string,
  detail: string,
  progress: number,
): Promise<void> {
  await query(
    `UPDATE ${tbl("repositories")}
        SET status = $1, status_detail = $2, progress = $3, updated_at = $4
      WHERE id = $5`,
    [status, detail, progress, Date.now(), repoId],
  );
}

async function markFailed(repoId: string, detail: string): Promise<void> {
  try {
    await query(
      `UPDATE ${tbl("repositories")}
          SET status = 'failed', status_detail = $1, updated_at = $2
        WHERE id = $3`,
      [detail, Date.now(), repoId],
    );
  } catch (error) {
    logger.error("could not mark repository failed", error, { repoId });
  }
}

/**
 * Delete a repository and everything under it.
 *
 * Unlike the SQLite version this needs no manual vector cleanup: embeddings
 * are a column on `chunks` rather than a separate virtual table, so the
 * existing `ON DELETE CASCADE` reaches them.
 */
export async function deleteRepository(repoId: string): Promise<void> {
  await query(`DELETE FROM ${tbl("repositories")} WHERE id = $1`, [repoId]);
  logger.info("repository deleted", { repoId });
}
