import "server-only";

import { query, tbl } from "@/lib/db";
import { logger } from "@/lib/observability/logger";
import type { TraceStats, TraceSummary } from "@/lib/types";

export interface TraceRecord {
  id: string;
  repoId: string | null;
  question: string;
  resolvedQuestion: string | null;
  intent: string | null;
  status: "answered" | "refused" | "no_context" | "error";
  refusalReason: string | null;
  retrieved: Array<{
    chunkId: number;
    path: string;
    lines: string;
    score: number;
    via: string;
  }>;
  retrievalMs: number;
  embedMs: number;
  llmMs: number;
  totalMs: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  model: string | null;
}

/**
 * One row per answered question.
 *
 * Logs alone are not enough for a RAG system: when an answer is wrong, the
 * question is almost always "what did retrieval actually return?", and that has
 * to be inspectable after the fact rather than reconstructed from stdout.
 * Persisting the retrieved chunk ids with their fusion scores and which
 * retriever found them turns debugging from guesswork into reading a row — and
 * it is the same data the offline eval harness scores.
 *
 * Callers fire-and-forget this, so it swallows its own errors: the answer has
 * already been streamed to the user by the time the trace is written, and
 * failing to persist a diagnostic must never surface as a failed answer — nor
 * as an unhandled rejection that takes the process down.
 */
export async function recordTrace(trace: TraceRecord): Promise<void> {
  try {
    await insertTrace(trace);
  } catch (error) {
    logger.error("could not record trace", error, { traceId: trace.id });
  }
}

async function insertTrace(trace: TraceRecord): Promise<void> {
  await query(
    `INSERT INTO ${tbl("traces")} (
       id, repo_id, question, resolved_question, intent, status, refusal_reason,
       retrieved, retrieval_ms, embed_ms, llm_ms, total_ms,
       prompt_tokens, completion_tokens, cost_usd, model, created_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
    [
      trace.id,
      trace.repoId,
      trace.question,
      trace.resolvedQuestion,
      trace.intent,
      trace.status,
      trace.refusalReason,
      JSON.stringify(trace.retrieved),
      trace.retrievalMs,
      trace.embedMs,
      trace.llmMs,
      trace.totalMs,
      trace.promptTokens,
      trace.completionTokens,
      trace.costUsd,
      trace.model,
      Date.now(),
    ],
  );
}

export async function listTraces(limit = 50): Promise<TraceSummary[]> {
  const rows = await query<Record<string, unknown>>(
    `SELECT id, question, resolved_question, status, intent, retrieved,
            retrieval_ms, llm_ms, total_ms, prompt_tokens, completion_tokens,
            cost_usd, model, created_at
       FROM ${tbl("traces")} ORDER BY created_at DESC LIMIT $1`,
    [limit],
  );

  return rows.map((row) => ({
    id: row.id as string,
    question: row.question as string,
    resolvedQuestion: row.resolved_question as string | null,
    status: row.status as string,
    intent: row.intent as string | null,
    // jsonb comes back already parsed by `pg`, unlike SQLite's TEXT column.
    retrieved: (row.retrieved as TraceRecord["retrieved"]) ?? [],
    retrievalMs: Number(row.retrieval_ms),
    llmMs: Number(row.llm_ms),
    totalMs: Number(row.total_ms),
    promptTokens: Number(row.prompt_tokens),
    completionTokens: Number(row.completion_tokens),
    costUsd: Number(row.cost_usd),
    model: row.model as string | null,
    createdAt: Number(row.created_at),
  }));
}

/**
 * Aggregate stats.
 *
 * Computed in Postgres rather than by pulling every row into Node — the SQLite
 * version could get away with `SELECT *` and sorting in JS because the query
 * was in-process and the table was small. `percentile_cont` over a growing
 * table is the difference between a few milliseconds and shipping the entire
 * trace history across the network on every panel open.
 */
export async function traceStats(): Promise<TraceStats> {
  const rows = await query<Record<string, unknown>>(
    `SELECT
       COUNT(*)::int                                              AS total,
       COUNT(*) FILTER (WHERE status = 'answered')::int           AS answered,
       COUNT(*) FILTER (WHERE status = 'refused')::int            AS refused,
       COUNT(*) FILTER (WHERE status = 'no_context')::int         AS no_context,
       COUNT(*) FILTER (WHERE status = 'error')::int              AS errors,
       COALESCE(percentile_cont(0.5) WITHIN GROUP (ORDER BY total_ms), 0)  AS p50,
       COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY total_ms), 0) AS p95,
       COALESCE(SUM(cost_usd), 0)                                 AS total_cost,
       COALESCE(AVG(prompt_tokens), 0)                            AS avg_prompt
     FROM ${tbl("traces")}`,
  );

  const row = rows[0] ?? {};
  return {
    total: Number(row.total ?? 0),
    answered: Number(row.answered ?? 0),
    refused: Number(row.refused ?? 0),
    noContext: Number(row.no_context ?? 0),
    errors: Number(row.errors ?? 0),
    p50Ms: Math.round(Number(row.p50 ?? 0)),
    p95Ms: Math.round(Number(row.p95 ?? 0)),
    totalCostUsd: Number(row.total_cost ?? 0),
    avgPromptTokens: Math.round(Number(row.avg_prompt ?? 0)),
  };
}
