import { z } from "zod";

/**
 * Every tunable lives here. Two reasons:
 *  - the RAG knobs (chunk size, k, RRF constant) are the things you actually
 *    want to sweep during evaluation, and hunting them across files is misery;
 *  - it gives one obvious place to document *why* each default was chosen.
 */
const EnvSchema = z.object({
  OPENAI_API_KEY: z.string().min(1, "OPENAI_API_KEY is required"),

  // gpt-4o / gpt-4o-mini are the deliberate defaults: universally available on
  // any OpenAI account, so a reviewer cloning this repo never hits a
  // model-not-found error. Override for better code reasoning if your account
  // has access (e.g. OPENAI_ANSWER_MODEL=gpt-4.1).
  OPENAI_ANSWER_MODEL: z.string().default("gpt-4o"),
  OPENAI_UTILITY_MODEL: z.string().default("gpt-4o-mini"),
  OPENAI_EMBEDDING_MODEL: z.string().default("text-embedding-3-small"),
  OPENAI_BASE_URL: z.string().url().optional(),

  // Postgres with the pgvector extension. Neon's *pooled* endpoint in
  // production (host contains `-pooler`); the direct endpoint is fine locally.
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  // Own schema rather than `public`, so this app can share a database with
  // something else without either of them owning the namespace.
  DATABASE_SCHEMA: z.string().regex(/^[a-z_][a-z0-9_]*$/).default("code_docs"),

  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),

  GITHUB_TOKEN: z.string().optional(),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | null = null;

/**
 * Parsed lazily rather than at module load so that `next build`, unit tests and
 * the lint step don't require a real API key.
 */
export function env(): Env {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}

/** Embedding dimensions, keyed by model. Used to size the vec0 table. */
const EMBEDDING_DIMS: Record<string, number> = {
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
  "text-embedding-ada-002": 1536,
};

export function embeddingDimensions(model: string): number {
  const dims = EMBEDDING_DIMS[model];
  if (!dims) {
    throw new Error(
      `Unknown embedding model "${model}". Add its dimensionality to EMBEDDING_DIMS in src/lib/config.ts.`,
    );
  }
  return dims;
}

export const RAG = {
  /**
   * Chunk sizing. 700 tokens is roughly a medium function plus its imports
   * header. Small enough that a top-12 retrieval fits comfortably in context,
   * big enough that a function is rarely cut in half.
   */
  maxChunkTokens: 700,
  minChunkTokens: 40,
  /** Lines of overlap when a single oversized unit must be hard-split. */
  overlapLines: 8,

  /** Candidates pulled from each retriever before fusion. */
  vectorCandidates: 30,
  keywordCandidates: 30,
  /** Chunks that actually reach the prompt. */
  finalK: 12,
  /**
   * Reciprocal Rank Fusion constant. 60 is the value from the original
   * Cormack et al. paper and behaves well without tuning; it damps the
   * influence of the very top rank so a single confident-but-wrong retriever
   * can't dominate the fused list.
   */
  rrfK: 60,
  /** Pull the chunk immediately before/after a strong hit from the same file. */
  neighbourExpansion: true,
  /** Hard ceiling on tokens of retrieved code sent to the answer model. */
  maxContextTokens: 12_000,
} as const;

export const INGEST = {
  maxFiles: 3_000,
  maxFileBytes: 256 * 1024,
  maxTotalBytes: 40 * 1024 * 1024,
  /** Embedding requests are batched; 96 keeps each request well under limits. */
  embeddingBatchSize: 96,
} as const;

export const LIMITS = {
  maxQuestionChars: 2_000,
  maxHistoryTurns: 8,
  /** Simple in-process token bucket. See src/lib/guardrails/rate-limit.ts. */
  requestsPerMinute: 20,
} as const;

/** USD per 1M tokens. Used for the cost column in the trace log. */
export const PRICING: Record<string, { input: number; output: number }> = {
  "gpt-4o": { input: 2.5, output: 10 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4.1": { input: 2.0, output: 8 },
  "gpt-4.1-mini": { input: 0.4, output: 1.6 },
  "text-embedding-3-small": { input: 0.02, output: 0 },
  "text-embedding-3-large": { input: 0.13, output: 0 },
};

export function estimateCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const price = PRICING[model];
  if (!price) return 0;
  return (
    (inputTokens / 1_000_000) * price.input +
    (outputTokens / 1_000_000) * price.output
  );
}
