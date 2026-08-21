import "server-only";

import { getDb } from "@/lib/db";
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
 * retriever found them turns debugging from guesswork into reading a row —
 * and it is the same data the offline eval harness scores.
 */
export function recordTrace(trace: TraceRecord): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO traces (
       id, repo_id, question, resolved_question, intent, status, refusal_reason,
       retrieved, retrieval_ms, embed_ms, llm_ms, total_ms,
       prompt_tokens, completion_tokens, cost_usd, model, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
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
  );
}

export function listTraces(limit = 50): TraceSummary[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, question, resolved_question, status, intent, retrieved,
              retrieval_ms, llm_ms, total_ms, prompt_tokens, completion_tokens,
              cost_usd, model, created_at
       FROM traces ORDER BY created_at DESC LIMIT ?`,
    )
    .all(limit) as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    id: row.id as string,
    question: row.question as string,
    resolvedQuestion: row.resolved_question as string | null,
    status: row.status as string,
    intent: row.intent as string | null,
    retrieved: safeParse(row.retrieved as string),
    retrievalMs: row.retrieval_ms as number,
    llmMs: row.llm_ms as number,
    totalMs: row.total_ms as number,
    promptTokens: row.prompt_tokens as number,
    completionTokens: row.completion_tokens as number,
    costUsd: row.cost_usd as number,
    model: row.model as string | null,
    createdAt: row.created_at as number,
  }));
}

export function traceStats(): TraceStats {
  const db = getDb();
  const rows = db
    .prepare("SELECT status, total_ms, cost_usd, prompt_tokens FROM traces")
    .all() as Array<{
    status: string;
    total_ms: number;
    cost_usd: number;
    prompt_tokens: number;
  }>;

  if (rows.length === 0) {
    return {
      total: 0, answered: 0, refused: 0, noContext: 0, errors: 0,
      p50Ms: 0, p95Ms: 0, totalCostUsd: 0, avgPromptTokens: 0,
    };
  }

  const durations = rows.map((r) => r.total_ms).sort((a, b) => a - b);
  const percentile = (p: number) =>
    durations[Math.min(durations.length - 1, Math.floor(durations.length * p))];

  return {
    total: rows.length,
    answered: rows.filter((r) => r.status === "answered").length,
    refused: rows.filter((r) => r.status === "refused").length,
    noContext: rows.filter((r) => r.status === "no_context").length,
    errors: rows.filter((r) => r.status === "error").length,
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    totalCostUsd: rows.reduce((sum, r) => sum + r.cost_usd, 0),
    avgPromptTokens: Math.round(
      rows.reduce((sum, r) => sum + r.prompt_tokens, 0) / rows.length,
    ),
  };
}

function safeParse(value: string): TraceRecord["retrieved"] {
  try {
    return JSON.parse(value ?? "[]");
  } catch {
    return [];
  }
}
