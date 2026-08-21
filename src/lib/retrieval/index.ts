import "server-only";

import { RAG } from "@/lib/config";
import { query, tbl, toVectorLiteral, transaction } from "@/lib/db";
import { embedQuery } from "@/lib/embeddings";
import { logger } from "@/lib/observability/logger";
import { buildTsQuery } from "./fts-query";
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

/**
 * Hybrid retrieval: dense vectors + Postgres full-text, fused with RRF.
 *
 * ## Why both, for code specifically
 * Embeddings capture intent ("how do we authenticate users") but are weak on
 * rare literal tokens — an exact identifier like `parseJwtPayload`, an error
 * string, or an env var name gets averaged into a generic "auth-ish" vector.
 * Lexical search nails those and is useless for paraphrase. Developer
 * questions are a mix of both.
 *
 * See the README for the eval numbers, which currently do *not* support fusion
 * beating dense alone on a small corpus.
 */
export async function retrieve(
  repoId: string,
  queryText: string,
  options: RetrieveOptions = {},
): Promise<RetrievalResult> {
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
  const queryVector = useVector ? await embedQuery(queryText) : null;
  const embedMs = performance.now() - embedStart;

  const searchStart = performance.now();
  const tsQuery = useKeyword ? buildTsQuery(queryText) : null;

  // The two retrievers are independent, so they go out concurrently — the
  // round trip to a hosted database dominates their cost and running them in
  // sequence would pay it twice for no reason.
  const [vectorHits, keywordHits] = await Promise.all([
    queryVector ? denseSearch(queryVector, repoId) : Promise.resolve([]),

    // `ts_rank_cd` rather than `ts_rank`: the cover-density variant accounts
    // for how close the matched terms sit to one another, a better relevance
    // proxy when a question contributes several related identifiers.
    //
    // Failure here degrades to vector-only rather than failing the question —
    // which is also why this is not inside a transaction with the query above.
    tsQuery
      ? query<{ id: string; rank: number }>(
          `SELECT id, ts_rank_cd(search, q) AS rank
             FROM ${tbl("chunks")}, to_tsquery('simple', $1) AS q
            WHERE repo_id = $2 AND search @@ q
            ORDER BY rank DESC
            LIMIT $3`,
          [tsQuery, repoId, RAG.keywordCandidates],
        ).catch((error: Error) => {
          logger.warn("text search failed, falling back to vector-only", {
            tsQuery,
            error: error.message,
          });
          return [];
        })
      : Promise.resolve([]),
  ]);

  // ---- Fuse -------------------------------------------------------------
  const fused = reciprocalRankFusion(
    [vectorHits.map((h) => Number(h.id)), keywordHits.map((h) => Number(h.id))],
    RAG.rrfK,
  );

  const vectorRanks = new Map(vectorHits.map((h, i) => [Number(h.id), i + 1]));
  const keywordRanks = new Map(keywordHits.map((h, i) => [Number(h.id), i + 1]));

  const selectedIds = fused.slice(0, k).map((f) => f.id);
  const withNeighbours = expand
    ? await expandWithNeighbours(selectedIds, repoId, k)
    : selectedIds;

  const rows = await loadChunks(withNeighbours);
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
      ftsQuery: tsQuery,
      contextTokens,
    },
  };
}

/**
 * How hard HNSW searches before giving up. pgvector's default is 40; the index
 * is approximate and this is the recall/latency dial. 100 is a deliberate
 * over-spend — at this corpus size the extra work is unmeasurable and it buys
 * noticeably better recall on the repo-filtered search below.
 */
const EF_SEARCH = 100;

/**
 * Dense KNN, wrapped in a transaction purely so the tuning can use `SET LOCAL`.
 *
 * `SET LOCAL` reverts on commit. A bare `SET` would mutate the pooled session
 * and silently become configuration for whichever request is handed that
 * connection next — one query's tuning leaking into everyone else's.
 */
async function denseSearch(
  queryVector: number[],
  repoId: string,
): Promise<Array<{ id: string; distance: number }>> {
  return transaction(async (client) => {
    // Both settings in one statement, because every extra round trip to a
    // hosted database is real latency — this search runs against Neon in
    // another region, where a round trip is ~100ms and the transaction is
    // already paying for BEGIN and COMMIT.
    //
    // THE FILTERED-SEARCH RECALL PROBLEM.
    //
    // An HNSW index knows only about vectors — it has no idea which rows
    // belong to which repository. Postgres walks the index in distance order
    // and only then discards rows failing `repo_id = $2`. Ask for 30 and the
    // scan may surface 30 candidates that all belong to a different repo,
    // leaving three results. The answer stays correct but silently
    // under-returns, and it degrades as more repositories are indexed.
    //
    // pgvector 0.8's iterative scan exists for exactly this: when the filter
    // eats the candidate set, keep scanning rather than returning short.
    // `strict_order` preserves true distance order — `relaxed_order` is faster
    // but can return results slightly out of order, which would make the top
    // match not actually the top match.
    //
    // `iterative_scan` is tolerated rather than required: on pgvector < 0.8 it
    // does not exist. Because a failed statement aborts the whole transaction,
    // the fallback re-issues just the setting that always works rather than
    // trying to continue from an aborted state.
    try {
      await client.query(
        `SET LOCAL hnsw.ef_search = ${EF_SEARCH};
         SET LOCAL hnsw.iterative_scan = 'strict_order';`,
      );
    } catch {
      logger.warn("hnsw.iterative_scan unavailable — pgvector < 0.8?");
      await client.query("ROLLBACK");
      await client.query("BEGIN");
      await client.query(`SET LOCAL hnsw.ef_search = ${EF_SEARCH}`);
    }

    const result = await client.query<{ id: string; distance: number }>(
      `SELECT id, (embedding <=> $1::vector) AS distance
         FROM ${tbl("chunks")}
        WHERE repo_id = $2
          -- A chunk written but not yet embedded (a crashed ingest, work in
          -- flight) has a NULL embedding, and NULL <=> vector is NULL, which
          -- sorts last under NULLS LAST — surfacing junk exactly when real
          -- matches run out, which is when it does the most damage.
          AND embedding IS NOT NULL
        ORDER BY embedding <=> $1::vector
        LIMIT $3`,
      [toVectorLiteral(queryVector), repoId, RAG.vectorCandidates],
    );
    return result.rows;
  });
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
 * Pull the chunks immediately before and after the strongest hits.
 *
 * Code is sequential in a way prose is not: a retrieved function body often
 * depends on the imports above it or the helper below it, and the model cannot
 * explain what it cannot see. Expanding only the top few hits keeps the cost
 * bounded while fixing the common "explains the call but not the callee"
 * failure.
 *
 * One round trip, not one per neighbour: the SQLite version could afford a
 * query per lookup because it was an in-process function call. Against a
 * hosted database that would be ~24 sequential round trips on every question.
 */
async function expandWithNeighbours(
  ids: number[],
  repoId: string,
  k: number,
): Promise<number[]> {
  if (ids.length === 0) return ids;

  // Only the top third of hits earn neighbours; beyond that the marginal
  // relevance does not justify the context spend.
  const seedCount = Math.ceil(ids.length / 3);
  const seedIds = ids.slice(0, seedCount);

  const neighbours = await query<{ id: string; seed_id: string }>(
    `SELECT n.id, s.id AS seed_id
       FROM ${tbl("chunks")} s
       JOIN ${tbl("chunks")} n
         ON n.file_id = s.file_id
        AND n.ordinal IN (s.ordinal - 1, s.ordinal + 1)
      WHERE s.id = ANY($1::bigint[]) AND n.repo_id = $2`,
    [seedIds, repoId],
  );

  const budget = Math.ceil(k * 1.5);
  const result: number[] = [];
  const seen = new Set<number>();

  const add = (id: number) => {
    if (seen.has(id) || result.length >= budget) return;
    seen.add(id);
    result.push(id);
  };

  // Interleave: each seed, then its neighbours, preserving fused rank order.
  for (const id of ids) {
    add(id);
    for (const n of neighbours.filter((row) => Number(row.seed_id) === id)) {
      add(Number(n.id));
    }
  }

  return result;
}

async function loadChunks(ids: number[]): Promise<ChunkRow[]> {
  if (ids.length === 0) return [];

  const rows = await query<Record<string, unknown>>(
    `SELECT c.id, f.path, f.language, c.symbol, c.start_line, c.end_line,
            c.content, c.token_count, c.file_id, c.ordinal
       FROM ${tbl("chunks")} c
       JOIN ${tbl("files")} f ON f.id = c.file_id
      WHERE c.id = ANY($1::bigint[])`,
    [ids],
  );

  // BIGINT comes back from `pg` as a string to avoid precision loss beyond
  // 2^53. Every id in this app is well inside safe-integer range, and the rest
  // of the code (maps, Sets, the wire format) assumes numbers — so normalise
  // once, here, rather than sprinkling Number() across every call site.
  return rows.map((row) => ({
    id: Number(row.id),
    path: row.path as string,
    language: row.language as string,
    symbol: row.symbol as string | null,
    start_line: Number(row.start_line),
    end_line: Number(row.end_line),
    content: row.content as string,
    token_count: Number(row.token_count),
    file_id: Number(row.file_id),
    ordinal: Number(row.ordinal),
  }));
}
