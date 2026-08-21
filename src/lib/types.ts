/**
 * Wire types shared by the server pipeline and the browser.
 *
 * Kept in a neutral module — no `server-only`, no Node imports — so the client
 * bundle can import them without dragging in better-sqlite3. The server
 * modules import from here too, which means a change to the protocol is a
 * single edit that both sides typecheck against.
 */

export type RepoStatus = "queued" | "indexing" | "ready" | "failed";

export interface RepoSummary {
  id: string;
  name: string;
  sourceType: "github" | "upload";
  sourceRef: string;
  commitRef: string | null;
  status: RepoStatus;
  statusDetail: string | null;
  progress: number;
  fileCount: number;
  chunkCount: number;
  createdAt: number;
}

export interface RepoDetail extends RepoSummary {
  embedTokens: number;
  summary: {
    languages: Array<{ language: string; files: number; share: number }>;
    entryPoints: string[];
    endpointCount: number;
    endpoints: Array<{ method: string; path: string; file: string; line: number }>;
    dependencies: Array<{ manifest: string; count: number; runtime: string[] }>;
  } | null;
}

export interface SourceRef {
  index: number;
  chunkId: number;
  path: string;
  language: string;
  symbol: string | null;
  startLine: number;
  endLine: number;
  /** Which retriever surfaced this chunk. */
  via: string;
  score: number;
}

export interface AnswerUsage {
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  retrievalMs: number;
  llmMs: number;
  totalMs: number;
  model: string;
}

export type AnswerEvent =
  | { type: "status"; stage: string }
  | { type: "sources"; sources: SourceRef[]; resolvedQuestion: string }
  | { type: "delta"; text: string }
  | { type: "done"; traceId: string; usage: AnswerUsage }
  | { type: "error"; message: string };

export interface TraceSummary {
  id: string;
  question: string;
  resolvedQuestion: string | null;
  status: string;
  intent: string | null;
  retrieved: Array<{
    chunkId: number;
    path: string;
    lines: string;
    score: number;
    via: string;
  }>;
  retrievalMs: number;
  llmMs: number;
  totalMs: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  model: string | null;
  createdAt: number;
}

export interface TraceStats {
  total: number;
  answered: number;
  refused: number;
  noContext: number;
  errors: number;
  p50Ms: number;
  p95Ms: number;
  totalCostUsd: number;
  avgPromptTokens: number;
}
