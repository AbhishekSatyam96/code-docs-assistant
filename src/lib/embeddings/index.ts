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
  const vectors: number[][] = [];
  let tokens = 0;

  for (let i = 0; i < texts.length; i += INGEST.embeddingBatchSize) {
    const batch = texts.slice(i, i + INGEST.embeddingBatchSize);
    const response = await openai().embeddings.create({
      model,
      input: batch,
      encoding_format: "float",
    });

    // The API documents that results come back in input order, but ordering is
    // load-bearing here (vector i must map to chunk i), so sort defensively.
    const ordered = [...response.data].sort((a, b) => a.index - b.index);
    for (const item of ordered) vectors.push(item.embedding);
    tokens += response.usage?.total_tokens ?? 0;
  }

  logger.debug("embedded batch", { count: texts.length, tokens, model });
  return { vectors, tokens };
}

/** Convenience wrapper for the single-text query path. */
export async function embedQuery(text: string): Promise<number[]> {
  const { vectors } = await embedTexts([text]);
  return vectors[0];
}
