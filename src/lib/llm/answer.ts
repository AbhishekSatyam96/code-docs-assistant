import "server-only";

import { nanoid } from "nanoid";

import { LIMITS, env, estimateCostUsd } from "@/lib/config";
import { query, tbl } from "@/lib/db";
import { triageQuestion } from "@/lib/guardrails/triage";
import { logger } from "@/lib/observability/logger";
import { recordTrace } from "@/lib/observability/traces";
import { renderRepoMap, type RepoMap } from "@/lib/ingest/repo-map";
import { retrieve, type RetrievedChunk } from "@/lib/retrieval";
import type { AnswerEvent, SourceRef } from "@/lib/types";
import { openai } from "./client";
import {
  ANSWER_SYSTEM_PROMPT,
  buildUserMessage,
  refusalMessage,
  renderSources,
} from "./prompts";

export type { AnswerEvent, SourceRef } from "@/lib/types";

export interface AskInput {
  repoId: string;
  question: string;
  history: Array<{ role: "user" | "assistant"; content: string }>;
}

/**
 * The full question-answering pipeline, as a stream of events.
 *
 * Modelled as an async generator so the route handler stays a thin transport
 * adapter: it serialises whatever this yields and owns none of the logic. That
 * also means the pipeline is directly testable and directly reusable from the
 * offline eval harness, without spinning up HTTP.
 *
 * Stages: triage → retrieve → generate → record. Status events are emitted
 * between stages because retrieval plus first token is 1-3 seconds, and a UI
 * that says "searching 1,240 chunks" reads as responsive where a bare spinner
 * reads as broken.
 */
export async function* ask(input: AskInput): AsyncGenerator<AnswerEvent> {
  const traceId = nanoid(10);
  const log = logger.bind({ traceId, repoId: input.repoId });
  const startedAt = performance.now();

  const [repo] = await query<{
    id: string;
    name: string;
    status: string;
    // jsonb is deserialised by `pg`, so this arrives as an object, not text.
    repo_map: RepoMap | null;
    chunk_count: string;
  }>(
    `SELECT id, name, status, repo_map, chunk_count FROM ${tbl("repositories")} WHERE id = $1`,
    [input.repoId],
  );

  if (!repo) {
    yield { type: "error", message: "That repository is no longer indexed." };
    return;
  }
  if (repo.status !== "ready") {
    yield {
      type: "error",
      message: `"${repo.name}" is still indexing. Give it a moment and try again.`,
    };
    return;
  }

  // ---- Guardrail + query understanding ----------------------------------
  yield { type: "status", stage: "Understanding the question" };

  const triage = await triageQuestion(
    input.question,
    input.history.slice(-LIMITS.maxHistoryTurns),
  );

  if (triage.intent !== "codebase_question") {
    const message = refusalMessage(triage.intent, triage.reason);
    yield { type: "sources", sources: [], resolvedQuestion: triage.resolvedQuestion };
    yield { type: "delta", text: message };

    void recordTrace({
      id: traceId,
      repoId: repo.id,
      question: input.question,
      resolvedQuestion: triage.resolvedQuestion,
      intent: triage.intent,
      status: "refused",
      refusalReason: triage.reason,
      retrieved: [],
      retrievalMs: 0,
      embedMs: 0,
      llmMs: 0,
      totalMs: Math.round(performance.now() - startedAt),
      promptTokens: 0,
      completionTokens: 0,
      costUsd: 0,
      model: env().OPENAI_UTILITY_MODEL,
    });

    log.info("question refused", { intent: triage.intent, reason: triage.reason });
    yield {
      type: "done",
      traceId,
      usage: {
        promptTokens: 0, completionTokens: 0, costUsd: 0,
        retrievalMs: 0, llmMs: 0,
        totalMs: Math.round(performance.now() - startedAt),
        model: env().OPENAI_UTILITY_MODEL,
      },
    };
    return;
  }

  // ---- Retrieval ---------------------------------------------------------
  yield { type: "status", stage: `Searching ${Number(repo.chunk_count).toLocaleString()} chunks` };

  // Appending the extracted keywords biases the sparse retriever toward the
  // identifiers the triage step believes matter, without disturbing the dense
  // side much (a handful of extra tokens barely moves a 1536-dim vector).
  const searchQuery = triage.keywords.length
    ? `${triage.resolvedQuestion}\n${triage.keywords.join(" ")}`
    : triage.resolvedQuestion;

  const retrieval = await retrieve(repo.id, searchQuery);

  const sources: SourceRef[] = retrieval.chunks.map((chunk, index) => ({
    index: index + 1,
    chunkId: chunk.chunkId,
    path: chunk.filePath,
    language: chunk.language,
    symbol: chunk.symbol,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
    via: chunk.via,
    score: chunk.score,
  }));

  yield { type: "sources", sources, resolvedQuestion: triage.resolvedQuestion };

  log.info("retrieval complete", {
    question: triage.resolvedQuestion,
    chunks: retrieval.chunks.length,
    ...retrieval.stats,
    ...retrieval.timings,
  });

  // ---- Generation --------------------------------------------------------
  yield { type: "status", stage: "Reading the code" };

  const repoMap: RepoMap | null = repo.repo_map;
  const userMessage = buildUserMessage({
    repoMap: repoMap ? renderRepoMap(repoMap, repo.name) : `Repository: ${repo.name}`,
    sources: renderSources(retrieval.chunks),
    question: triage.resolvedQuestion,
  });

  const model = env().OPENAI_ANSWER_MODEL;
  const llmStart = performance.now();

  let answerText = "";
  let promptTokens = 0;
  let completionTokens = 0;

  try {
    const stream = await openai().chat.completions.create({
      model,
      temperature: 0.1, // near-deterministic: this is extraction, not writing
      max_tokens: 1_600,
      stream: true,
      stream_options: { include_usage: true },
      messages: [
        { role: "system", content: ANSWER_SYSTEM_PROMPT },
        ...toHistory(input.history),
        { role: "user", content: userMessage },
      ],
    });

    for await (const part of stream) {
      const delta = part.choices[0]?.delta?.content;
      if (delta) {
        answerText += delta;
        yield { type: "delta", text: delta };
      }
      if (part.usage) {
        promptTokens = part.usage.prompt_tokens;
        completionTokens = part.usage.completion_tokens;
      }
    }
  } catch (error) {
    log.error("generation failed", error);
    void recordTrace({
      id: traceId, repoId: repo.id, question: input.question,
      resolvedQuestion: triage.resolvedQuestion, intent: triage.intent,
      status: "error", refusalReason: (error as Error).message,
      retrieved: summariseRetrieved(retrieval.chunks),
      retrievalMs: retrieval.timings.totalMs, embedMs: retrieval.timings.embedMs,
      llmMs: Math.round(performance.now() - llmStart),
      totalMs: Math.round(performance.now() - startedAt),
      promptTokens, completionTokens, costUsd: 0, model,
    });
    yield {
      type: "error",
      message: "The model call failed. Check the server logs and your OpenAI quota.",
    };
    return;
  }

  const llmMs = Math.round(performance.now() - llmStart);
  const totalMs = Math.round(performance.now() - startedAt);
  const costUsd =
    estimateCostUsd(model, promptTokens, completionTokens) +
    estimateCostUsd(env().OPENAI_EMBEDDING_MODEL, 0, 0);

  void recordTrace({
    id: traceId,
    repoId: repo.id,
    question: input.question,
    resolvedQuestion: triage.resolvedQuestion,
    intent: triage.intent,
    status: retrieval.chunks.length === 0 ? "no_context" : "answered",
    refusalReason: null,
    retrieved: summariseRetrieved(retrieval.chunks),
    retrievalMs: retrieval.timings.totalMs,
    embedMs: retrieval.timings.embedMs,
    llmMs,
    totalMs,
    promptTokens,
    completionTokens,
    costUsd,
    model,
  });

  log.info("answered", {
    promptTokens, completionTokens, costUsd, llmMs, totalMs,
    answerChars: answerText.length,
  });

  yield {
    type: "done",
    traceId,
    usage: {
      promptTokens,
      completionTokens,
      costUsd,
      retrievalMs: retrieval.timings.totalMs,
      llmMs,
      totalMs,
      model,
    },
  };
}

/**
 * Prior turns are replayed as plain text without their source blocks.
 *
 * Re-sending every earlier turn's retrieved code would blow the context budget
 * after three or four questions and, worse, let stale excerpts outweigh the
 * ones retrieved for the current question. Keeping the conversational thread
 * but re-retrieving fresh evidence each turn is the right trade for a Q&A tool.
 */
function toHistory(
  history: Array<{ role: "user" | "assistant"; content: string }>,
): Array<{ role: "user" | "assistant"; content: string }> {
  return history.slice(-LIMITS.maxHistoryTurns).map((message) => ({
    role: message.role,
    content: message.content.slice(0, 4_000),
  }));
}

function summariseRetrieved(chunks: RetrievedChunk[]) {
  return chunks.map((chunk) => ({
    chunkId: chunk.chunkId,
    path: chunk.filePath,
    lines: `${chunk.startLine}-${chunk.endLine}`,
    score: Number(chunk.score.toFixed(5)),
    via: chunk.via,
  }));
}
