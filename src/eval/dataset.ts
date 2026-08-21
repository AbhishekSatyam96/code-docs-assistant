/**
 * Golden retrieval set.
 *
 * The questions target this repository's own source, so the eval is
 * reproducible with no network, no fixture downloads, and no drift when an
 * upstream project changes. `expectedFiles` is a list of acceptable answers —
 * a question is a hit if *any* of them is retrieved, because several of these
 * genuinely have more than one right answer.
 *
 * Deliberately includes the awkward cases, not just the easy ones:
 *  - `lexical` questions name an exact identifier (BM25 should win)
 *  - `semantic` questions describe behaviour without naming anything
 *    (embeddings should win)
 *  - `structural` questions are about the repo as a whole, which retrieval
 *    alone answers badly — those are what the repo map exists for.
 *
 * 18 questions is small enough to hand-label honestly and large enough that a
 * one-question change does not swing the score by ten points. It is a
 * regression guard, not a benchmark.
 */

export type QuestionKind = "lexical" | "semantic" | "structural";

export interface EvalQuestion {
  id: string;
  question: string;
  kind: QuestionKind;
  expectedFiles: string[];
}

export const EVAL_QUESTIONS: EvalQuestion[] = [
  {
    id: "rrf",
    question: "How are the results of the two retrievers combined?",
    kind: "semantic",
    expectedFiles: ["lib/retrieval/fusion.ts", "lib/retrieval/index.ts"],
  },
  {
    id: "rrf-named",
    question: "What does reciprocalRankFusion do?",
    kind: "lexical",
    expectedFiles: ["lib/retrieval/fusion.ts"],
  },
  {
    id: "chunk-strategy",
    question: "How is source code split up before it gets embedded?",
    kind: "semantic",
    expectedFiles: ["lib/ingest/chunker.ts"],
  },
  {
    id: "chunk-oversize",
    question: "What happens when a single function is too large to fit in one chunk?",
    kind: "semantic",
    expectedFiles: ["lib/ingest/chunker.ts"],
  },
  {
    id: "buildTsQuery",
    question: "Where is buildTsQuery defined?",
    kind: "lexical",
    expectedFiles: ["lib/retrieval/fts-query.ts"],
  },
  {
    id: "fts-injection",
    question: "How is the user's question stopped from injecting tsquery operators?",
    kind: "semantic",
    expectedFiles: ["lib/retrieval/fts-query.ts"],
  },
  {
    id: "ssrf",
    question: "What stops someone pointing the ingester at an internal URL?",
    kind: "semantic",
    expectedFiles: ["lib/ingest/sources.ts"],
  },
  {
    id: "tarball",
    question: "How is a GitHub repository downloaded and unpacked?",
    kind: "semantic",
    expectedFiles: ["lib/ingest/sources.ts"],
  },
  {
    id: "rate-limit",
    question: "Is there any rate limiting?",
    kind: "semantic",
    expectedFiles: ["lib/guardrails/rate-limit.ts"],
  },
  {
    id: "triage",
    question: "How does the system decide a question is off topic?",
    kind: "semantic",
    expectedFiles: ["lib/guardrails/triage.ts"],
  },
  {
    id: "prompt-injection",
    question: "How is prompt injection from indexed source code handled?",
    kind: "semantic",
    expectedFiles: ["lib/llm/prompts.ts"],
  },
  {
    id: "citations",
    question: "How do citation numbers in the answer become clickable?",
    kind: "semantic",
    expectedFiles: ["components/Message.tsx"],
  },
  {
    id: "pgvector",
    question: "How are embeddings stored and queried?",
    kind: "semantic",
    expectedFiles: ["lib/db/index.ts", "lib/retrieval/index.ts"],
  },
  {
    id: "toVectorLiteral",
    question: "What is toVectorLiteral for?",
    kind: "lexical",
    expectedFiles: ["lib/db/index.ts"],
  },
  {
    id: "streaming",
    question: "How does the answer get streamed to the browser?",
    kind: "semantic",
    expectedFiles: ["app/api/chat/route.ts", "lib/client/api.ts"],
  },
  {
    id: "traces",
    question: "Where is per-question latency and cost recorded?",
    kind: "semantic",
    expectedFiles: ["lib/observability/traces.ts"],
  },
  {
    id: "endpoints",
    question: "What API endpoints does this application expose?",
    kind: "structural",
    expectedFiles: [
      "app/api/chat/route.ts",
      "app/api/repos/route.ts",
      "app/api/files/route.ts",
      "app/api/traces/route.ts",
    ],
  },
  {
    id: "config",
    question: "Where are the tunable RAG parameters like chunk size and top-k?",
    kind: "structural",
    expectedFiles: ["lib/config.ts"],
  },
];
