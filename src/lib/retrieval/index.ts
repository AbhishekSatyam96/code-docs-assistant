import "server-only";

import { RAG } from "@/lib/config";
import { getDb, toVectorBlob } from "@/lib/db";
import { embedQuery } from "@/lib/embeddings";
import { logger } from "@/lib/observability/logger";
import { buildFtsQuery } from "./fts-query";
import { reciprocalRankFusion } from "./fusion";

export interface RetrievedChunk {
  chunkId: number;
  filePath: string;
  language: string;
  symbol: string | null;
  startLine: number;
  endLine: number;
  content: string;
  tokenCount: number;
  score: number;
  vectorRank: number | null;
  keywordRank: number | null;
  via: "vector" | "keyword" | "both" | "neighbour";
}

export interface RetrievalResult {
  chunks: RetrievedChunk[];
  timings: { embedMs: number; searchMs: number; totalMs: number };
  stats: {
    vectorCandidates: number;
    keywordCandidates: number;
    ftsQuery: string | null;
    contextTokens: number;
  };
}

/**
 * Which retrievers to run. `hybrid` is what the product uses; the single-
 * retriever modes exist so the offline eval can measure what fusion is
 * actually buying, rather than asserting it helps.
 */
export type RetrievalMode = "hybrid" | "vector" | "keyword";

export interface RetrieveOptions {
  k?: number;
  mode?: RetrievalMode;
  /**
   * Neighbour expansion is on in production but should be off when measuring
   * retriever quality: pulling in adjacent chunks from an already-correct file
   * inflates file-level recall without the retriever having earned it.
   */
  expand?: boolean;
}

interface ChunkRow {
  id: number;
  path: string;
  language: string;
  symbol: string | null;
  start_line: number;
  end_line: number;
  content: string;
  token_count: number;
  file_id: number;
  ordinal: number;
}

/**
 * Hybrid retrieval: dense vectors + BM25 keyword, fused with RRF.
 *
 * ## Why both, for code specifically
 * Embeddings capture intent ("how do we authenticate users") but are weak on
 * rare literal tokens — an exact identifier like `parseJwtPayload`, an error
 * string, or an env var name gets averaged into a generic "auth-ish" vector.
 * BM25 nails those and is useless for paraphrase. Developer questions are a
 * near-even mix of the two, so running only one retriever loses half the
 * queries. Fusing them was worth several points of recall in my eval set;
 * the numbers are in the README.
 */
export async function retrieve(
  repoId: string,
  query: string,
  options: RetrieveOptions = {},
): Promise<RetrievalResult> {
  const db = getDb();
  const k = options.k ?? RAG.finalK;
  const mode = options.mode ?? "hybrid";
  const expand = options.expand ?? RAG.neighbourExpansion;
  const startedAt = performance.now();

  const useVector = mode === "hybrid" || mode === "vector";
  const useKeyword = mode === "hybrid" || mode === "keyword";

  // ---- Dense ------------------------------------------------------------
  const embedStart = performance.now();
  // Skipped entirely in keyword-only mode — no point paying for an embedding
  // that is never used.
  const queryVector = useVector ? await embedQuery(query) : null;
  const embedMs = performance.now() - embedStart;

  const searchStart = performance.now();

  const vectorHits = queryVector
    ? (db
        .prepare(
          `SELECT chunk_id AS id, distance
           FROM chunk_vectors
           WHERE repo_id = ? AND embedding MATCH ? AND k = ?
           ORDER BY distance`,
        )
        .all(repoId, toVectorBlob(queryVector), RAG.vectorCandidates) as Array<{
        id: number;
        distance: number;
      }>)
    : [];

  // ---- Sparse -----------------------------------------------------------
  const ftsQuery = useKeyword ? buildFtsQuery(query) : null;
  let keywordHits: Array<{ id: number; score: number }> = [];

  if (ftsQuery) {
    try {
      keywordHits = db
        .prepare(
          `SELECT c.id AS id, bm25(chunks_fts) AS score
           FROM chunks_fts
           JOIN chunks c ON c.id = chunks_fts.rowid
           WHERE chunks_fts MATCH ? AND c.repo_id = ?
           ORDER BY rank
           LIMIT ?`,
        )
        .all(ftsQuery, repoId, RAG.keywordCandidates) as Array<{
        id: number;
        score: number;
      }>;
    } catch (error) {
      // A malformed MATCH expression must degrade to vector-only rather than
      // failing the user's question outright.
      logger.warn("fts query rejected, falling back to vector-only", {
        ftsQuery,
        error: (error as Error).message,
      });
    }
  }

  // ---- Fuse -------------------------------------------------------------
  const fused = reciprocalRankFusion(
    [vectorHits.map((h) => h.id), keywordHits.map((h) => h.id)],
    RAG.rrfK,
  );

  const vectorRanks = new Map(vectorHits.map((h, i) => [h.id, i + 1]));
  const keywordRanks = new Map(keywordHits.map((h, i) => [h.id, i + 1]));

  const selectedIds = fused.slice(0, k).map((f) => f.id);
  const withNeighbours = expand
    ? expandWithNeighbours(selectedIds, repoId, k)
    : selectedIds;

  const rows = loadChunks(withNeighbours);
  const byId = new Map(rows.map((r) => [r.id, r]));

  const chunks: RetrievedChunk[] = [];
  let contextTokens = 0;

  for (const id of withNeighbours) {
    const row = byId.get(id);
    if (!row) continue;

    // Hard context budget. Retrieval can legitimately return more good
    // material than fits; truncating here (rather than letting the API reject
    // an oversized request) keeps cost and latency predictable.
    if (contextTokens + row.token_count > RAG.maxContextTokens) continue;
    contextTokens += row.token_count;

    const vectorRank = vectorRanks.get(id) ?? null;
    const keywordRank = keywordRanks.get(id) ?? null;

    chunks.push({
      chunkId: row.id,
      filePath: row.path,
      language: row.language,
      symbol: row.symbol,
      startLine: row.start_line,
      endLine: row.end_line,
      content: row.content,
      tokenCount: row.token_count,
      score: fused.find((f) => f.id === id)?.score ?? 0,
      vectorRank,
      keywordRank,
      via:
        vectorRank && keywordRank
          ? "both"
          : vectorRank
            ? "vector"
            : keywordRank
              ? "keyword"
              : "neighbour",
    });
  }

  const searchMs = performance.now() - searchStart;

  return {
    chunks,
    timings: {
      embedMs: Math.round(embedMs),
      searchMs: Math.round(searchMs),
      totalMs: Math.round(performance.now() - startedAt),
    },
    stats: {
      vectorCandidates: vectorHits.length,
      keywordCandidates: keywordHits.length,
      ftsQuery,
      contextTokens,
    },
  };
}

/**
 * Pull the chunks immediately before and after the strongest hits.
 *
 * Code is sequential in a way prose is not: a retrieved function body very
 * often depends on the imports above it or the helper below it, and the model
 * cannot explain what it cannot see. Expanding only the top few hits keeps the
 * cost bounded while fixing the common "explains the call but not the callee"
 * failure.
 */
function expandWithNeighbours(ids: number[], repoId: string, k: number): number[] {
  if (ids.length === 0) return ids;
  const db = getDb();

  const seeds = db
    .prepare(
      `SELECT id, file_id, ordinal FROM chunks WHERE id IN (${ids.map(() => "?").join(",")})`,
    )
    .all(...ids) as Array<{ id: number; file_id: number; ordinal: number }>;

  const seedById = new Map(seeds.map((s) => [s.id, s]));
  const result: number[] = [];
  const seen = new Set<number>();
  const budget = Math.ceil(k * 1.5);

  const neighbourStmt = db.prepare(
    `SELECT id FROM chunks WHERE repo_id = ? AND file_id = ? AND ordinal = ?`,
  );

  for (const id of ids) {
    if (!seen.has(id)) {
      result.push(id);
      seen.add(id);
    }

    // Only the top third of hits earn neighbours; beyond that the marginal
    // relevance does not justify the context spend.
    if (result.length >= budget) break;
    if (ids.indexOf(id) >= Math.ceil(ids.length / 3)) continue;

    const seed = seedById.get(id);
    if (!seed) continue;

    for (const delta of [-1, 1]) {
      const neighbour = neighbourStmt.get(repoId, seed.file_id, seed.ordinal + delta) as
        | { id: number }
        | undefined;
      if (neighbour && !seen.has(neighbour.id) && result.length < budget) {
        result.push(neighbour.id);
        seen.add(neighbour.id);
      }
    }
  }

  return result;
}

function loadChunks(ids: number[]): ChunkRow[] {
  if (ids.length === 0) return [];
  const db = getDb();
  return db
    .prepare(
      `SELECT c.id, f.path, f.language, c.symbol, c.start_line, c.end_line,
              c.content, c.token_count, c.file_id, c.ordinal
       FROM chunks c
       JOIN files f ON f.id = c.file_id
       WHERE c.id IN (${ids.map(() => "?").join(",")})`,
    )
    .all(...ids) as ChunkRow[];
}
