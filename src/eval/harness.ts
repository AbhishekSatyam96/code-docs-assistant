import "server-only";

import fs from "node:fs";
import path from "node:path";

import { deleteRepository, startIngestion } from "@/lib/ingest/pipeline";
import { shouldIndex } from "@/lib/ingest/languages";
import { retrieve, type RetrievalMode } from "@/lib/retrieval";
import { EVAL_QUESTIONS, type EvalQuestion, type QuestionKind } from "./dataset";

export interface QuestionResult {
  id: string;
  kind: QuestionKind;
  question: string;
  hit: boolean;
  /** 1-based position of the first expected file, or null if never retrieved. */
  rank: number | null;
  retrievedFiles: string[];
}

export interface ModeReport {
  mode: RetrievalMode;
  recall: number;
  mrr: number;
  byKind: Record<QuestionKind, { hits: number; total: number }>;
  results: QuestionResult[];
  latencyMs: number;
}

export interface EvalReport {
  repoId: string;
  fileCount: number;
  chunkCount: number;
  k: number;
  modes: ModeReport[];
}

/** Read a directory into the shape the upload ingestion path expects. */
export function readDirectory(root: string, maxFiles = 3_000) {
  const files: Array<{ path: string; content: string }> = [];
  const rootName = path.basename(path.resolve(root));

  const walk = (dir: string) => {
    if (files.length >= maxFiles) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");

      if (entry.isDirectory()) {
        // Cheap prune so we never descend into node_modules at all.
        if (shouldIndex(`${relative}/probe.ts`)) walk(absolute);
        continue;
      }
      if (!entry.isFile() || !shouldIndex(relative)) continue;
      if (fs.statSync(absolute).size > 256 * 1024) continue;

      // The ingestion path strips the first segment (the folder the browser
      // prepends), so re-add it here to keep stored paths aligned.
      files.push({
        path: `${rootName}/${relative}`,
        content: fs.readFileSync(absolute, "utf8"),
      });
    }
  };

  walk(root);
  return { rootName, files };
}

/**
 * Index a directory, then score each retrieval mode against the golden set.
 *
 * Metrics are deliberately file-level rather than chunk-level. Chunk
 * boundaries move whenever the chunker is tuned, which would make the numbers
 * incomparable across exactly the changes the eval exists to evaluate. "Did we
 * surface the right file?" is stable and is what actually determines whether
 * the model can answer.
 *
 * Reported:
 *  - recall@k: share of questions where an expected file appears in the top k
 *  - MRR: mean reciprocal rank of the first expected file, which rewards
 *    ranking the right file 1st rather than 10th (recall alone cannot see that)
 */
export async function runEvaluation(options: {
  directory: string;
  k?: number;
  modes?: RetrievalMode[];
  questions?: EvalQuestion[];
  onProgress?: (message: string) => void;
}): Promise<EvalReport> {
  const k = options.k ?? 10;
  const modes = options.modes ?? (["hybrid", "vector", "keyword"] as RetrievalMode[]);
  const questions = options.questions ?? EVAL_QUESTIONS;
  const report = options.onProgress ?? (() => {});

  const { rootName, files } = readDirectory(options.directory);
  if (files.length === 0) {
    throw new Error(`No indexable files found under ${options.directory}`);
  }

  report(`Indexing ${files.length} files from ${rootName}…`);
  const started = startIngestion({
    sourceType: "upload",
    sourceRef: `eval:${rootName}`,
    files,
  });
  await started.done;

  const { getDb } = await import("@/lib/db");
  const repo = getDb()
    .prepare("SELECT status, status_detail, file_count, chunk_count FROM repositories WHERE id = ?")
    .get(started.id) as {
    status: string;
    status_detail: string;
    file_count: number;
    chunk_count: number;
  };

  if (repo.status !== "ready") {
    throw new Error(`Indexing failed: ${repo.status_detail}`);
  }
  report(`Indexed ${repo.file_count} files into ${repo.chunk_count} chunks.`);

  const modeReports: ModeReport[] = [];

  for (const mode of modes) {
    report(`Scoring ${mode}…`);
    const results: QuestionResult[] = [];
    const startedAt = performance.now();

    for (const question of questions) {
      // Expansion off: it would credit a retriever for a neighbouring chunk of
      // a file it had already found, which measures nothing.
      const result = await retrieve(started.id, question.question, {
        k,
        mode,
        expand: false,
      });

      const retrievedFiles = dedupe(result.chunks.map((c) => c.filePath));
      const rank =
        retrievedFiles.findIndex((file) =>
          question.expectedFiles.some((expected) => file.endsWith(expected)),
        ) + 1;

      results.push({
        id: question.id,
        kind: question.kind,
        question: question.question,
        hit: rank > 0,
        rank: rank > 0 ? rank : null,
        retrievedFiles: retrievedFiles.slice(0, 5),
      });
    }

    const hits = results.filter((r) => r.hit);
    const byKind = {} as ModeReport["byKind"];
    for (const kind of ["lexical", "semantic", "structural"] as QuestionKind[]) {
      const subset = results.filter((r) => r.kind === kind);
      byKind[kind] = { hits: subset.filter((r) => r.hit).length, total: subset.length };
    }

    modeReports.push({
      mode,
      recall: hits.length / results.length,
      mrr:
        results.reduce((sum, r) => sum + (r.rank ? 1 / r.rank : 0), 0) / results.length,
      byKind,
      results,
      latencyMs: Math.round((performance.now() - startedAt) / questions.length),
    });
  }

  // The eval index is disposable — leaving it behind would pollute the app's
  // repository list on the next `npm run dev`.
  deleteRepository(started.id);

  return {
    repoId: started.id,
    fileCount: repo.file_count,
    chunkCount: repo.chunk_count,
    k,
    modes: modeReports,
  };
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}
