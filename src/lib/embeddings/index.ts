import "server-only";

import { INGEST, env } from "@/lib/config";
import { openai } from "@/lib/llm/client";
import { logger } from "@/lib/observability/logger";

export interface EmbeddingResult {
  vectors: number[][];
  tokens: number;
}

/**
 * Embed a batch of texts.
 *
 * Batching is the whole game for ingestion cost and latency: one request per
 * chunk on a 2,000-chunk repo means 2,000 round trips, and at ~200ms each that
 * is seven minutes of pure network wait. Batches of 96 bring it under a
 * minute. The batch size is bounded by the API's per-request token limit
 * rather than by count, so it is set conservatively.
 */
export async function embedTexts(texts: string[]): Promise<EmbeddingResult> {
  if (texts.length === 0) return { vectors: [], tokens: 0 };

  const model = env().OPENAI_EMBEDDING_MODEL;

  const batches: string[][] = [];
  for (let i = 0; i < texts.length; i += INGEST.embeddingBatchSize) {
    batches.push(texts.slice(i, i + INGEST.embeddingBatchSize));
  }

  // Batches go out concurrently, a few at a time.
  //
  // Sequentially, a 438-chunk repo is 5 requests at ~6s each — 30 seconds of
  // almost pure waiting, and the dominant cost of the whole ingest once the
  // database writes were batched. These requests are independent, so the only
  // reason to serialise them was that a `for` loop is the obvious way to write
  // it.
  //
  // Concurrency is capped rather than unbounded: firing 30 requests at once on
  // a large repo invites a 429, and the SDK's retry would then cost more than
  // the serialisation saved.
  const results = await mapWithConcurrency(batches, INGEST.embeddingConcurrency, async (batch) => {
    const response = await openai().embeddings.create({
      model,
      input: batch,
      encoding_format: "float",
    });
    // The API documents that results come back in input order, but ordering is
    // load-bearing here (vector i must map to chunk i), so sort defensively.
    const ordered = [...response.data].sort((a, b) => a.index - b.index);
    return {
      vectors: ordered.map((item) => item.embedding),
      tokens: response.usage?.total_tokens ?? 0,
    };
  });

  // `mapWithConcurrency` preserves input order, so flattening restores the
  // original text order — which is the invariant every caller depends on.
  const vectors = results.flatMap((r) => r.vectors);
  const tokens = results.reduce((sum, r) => sum + r.tokens, 0);

  logger.debug("embedded batch", {
    count: texts.length,
    requests: batches.length,
    tokens,
    model,
  });
  return { vectors, tokens };
}

/**
 * `Promise.all` with a ceiling on in-flight work, preserving input order.
 *
 * Workers pull from a shared cursor and write into the slot they claimed, so
 * the output array lines up with the input regardless of completion order.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const worker = async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index]);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
  return results;
}

/** Convenience wrapper for the single-text query path. */
export async function embedQuery(text: string): Promise<number[]> {
  const { vectors } = await embedTexts([text]);
  return vectors[0];
}
