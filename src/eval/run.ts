/**
 * CLI for the retrieval eval.
 *
 *   npm run eval                 # index ./src, score all three modes
 *   npm run eval -- --dir ./src/lib --k 5
 *
 * Costs a few cents of embeddings per run (one pass over the directory plus
 * one query embedding per question per dense mode).
 */
import path from "node:path";

import { runEvaluation, type ModeReport } from "./harness";

async function main() {
  const args = process.argv.slice(2);
  const flag = (name: string) => {
    const index = args.indexOf(`--${name}`);
    return index === -1 ? undefined : args[index + 1];
  };

  const directory = path.resolve(flag("dir") ?? "./src");
  const k = Number(flag("k") ?? 10);
  // The golden questions live in `eval/dataset.ts`. Indexing them would let
  // every question match the answer key verbatim, so they are held out.
  const exclude = (flag("exclude") ?? "eval").split(",").filter(Boolean);

  for (const required of ["OPENAI_API_KEY", "DATABASE_URL"]) {
    if (process.env[required]) continue;
    console.error(`${required} is not set. Copy .env.example to .env first.`);
    process.exit(1);
  }

  // The eval indexes a throwaway corpus, so it gets its own schema rather than
  // writing into — and then deleting from — the schema the app is serving.
  process.env.DATABASE_SCHEMA = process.env.EVAL_DATABASE_SCHEMA ?? "code_docs_eval";
  process.env.LOG_LEVEL ??= "warn";

  console.log(`\nRetrieval evaluation — ${directory} (k=${k})\n`);

  const report = await runEvaluation({
    directory,
    k,
    exclude,
    onProgress: (message) => console.log(`  ${message}`),
  });

  console.log(
    `\n${report.fileCount} files · ${report.chunkCount} chunks · ${report.modes[0].results.length} questions\n`,
  );

  printSummary(report.modes, k);
  printByKind(report.modes);
  printMisses(report.modes);
}

function printSummary(modes: ModeReport[], k: number) {
  console.log(pad("mode", 10) + pad(`recall@${k}`, 12) + pad("MRR", 8) + "ms/query");
  console.log("─".repeat(42));
  for (const mode of modes) {
    console.log(
      pad(mode.mode, 10) +
        pad(percent(mode.recall), 12) +
        pad(mode.mrr.toFixed(3), 8) +
        String(mode.latencyMs),
    );
  }
  console.log();
}

function printByKind(modes: ModeReport[]) {
  const kinds = ["lexical", "semantic", "structural"] as const;
  console.log(pad("mode", 10) + kinds.map((kind) => pad(kind, 13)).join(""));
  console.log("─".repeat(52));
  for (const mode of modes) {
    console.log(
      pad(mode.mode, 10) +
        kinds
          .map((kind) => {
            const { hits, total } = mode.byKind[kind];
            return pad(`${hits}/${total}`, 13);
          })
          .join(""),
    );
  }
  console.log();
}

/** Misses are the actionable output — they say what to fix next. */
function printMisses(modes: ModeReport[]) {
  const hybrid = modes.find((m) => m.mode === "hybrid");
  const misses = hybrid?.results.filter((r) => !r.hit) ?? [];

  if (misses.length === 0) {
    console.log("No misses in hybrid mode.\n");
    return;
  }

  console.log(`Hybrid misses (${misses.length}):\n`);
  for (const miss of misses) {
    console.log(`  ${miss.id}  ${miss.question}`);
    console.log(`    got: ${miss.retrievedFiles.join(", ") || "(nothing)"}\n`);
  }
}

const pad = (value: string, width: number) => value.padEnd(width);
const percent = (value: number) => `${(value * 100).toFixed(1)}%`;

main()
  .then(() => closePool())
  .catch(async (error) => {
    console.error("\nEvaluation failed:", error instanceof Error ? error.message : error);
    await closePool();
    process.exit(1);
  });

/**
 * A connection pool holds the event loop open, so without this the CLI prints
 * its report and then hangs until the idle timeout — which looks exactly like
 * the eval itself being stuck.
 */
async function closePool(): Promise<void> {
  const { closeDb } = await import("@/lib/db");
  await closeDb().catch(() => undefined);
}
