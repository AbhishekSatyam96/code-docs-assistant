"use client";

import type { RepoDetail } from "@/lib/types";
import { BoxIcon, LayersIcon, RouteIcon, SearchIcon, SparkIcon } from "./icons";

interface Props {
  repo: RepoDetail | null;
  onPickQuestion: (question: string) => void;
}

/**
 * Empty state.
 *
 * Rather than a blank canvas, this shows what the system actually understood
 * about the repository — languages, entry points, routes, dependencies — which
 * both proves indexing worked and teaches the user what kinds of question this
 * tool can answer. The starter questions are derived from that same analysis,
 * so they are never suggestions the index cannot support.
 */
export function RepoOverview({ repo, onPickQuestion }: Props) {
  if (!repo) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/10 ring-1 ring-accent/25">
          <SparkIcon className="h-6 w-6 text-accent-soft" />
        </div>
        <h2 className="text-lg font-semibold text-ink">Index a codebase to begin</h2>
        <p className="mt-2 max-w-sm text-sm leading-relaxed text-ink-muted">
          Paste a GitHub URL or pick a local folder. The repository is chunked
          along declaration boundaries, embedded, and indexed for hybrid search —
          then you can ask it anything.
        </p>
      </div>
    );
  }

  if (repo.status !== "ready") {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <div className="mb-4 h-10 w-10 animate-spin rounded-full border-2 border-line border-t-accent" />
        <h2 className="text-base font-medium text-ink">Indexing {repo.name}</h2>
        <p className="mt-1.5 font-mono text-xs text-ink-muted">
          {repo.statusDetail ?? "Working…"}
        </p>
        <div className="mt-4 h-1 w-64 overflow-hidden rounded-full bg-surface-3">
          <div
            className="h-full rounded-full bg-accent transition-[width] duration-500"
            style={{ width: `${Math.max(3, Math.round(repo.progress * 100))}%` }}
          />
        </div>
      </div>
    );
  }

  const summary = repo.summary;
  const questions = buildQuestions(repo);

  return (
    <div className="space-y-6 pt-4">
      <header>
        <h2 className="text-xl font-semibold tracking-tight text-white">{repo.name}</h2>
        <p className="mt-1 font-mono text-xs text-ink-faint">
          {repo.fileCount.toLocaleString()} files · {repo.chunkCount.toLocaleString()}{" "}
          chunks · {repo.embedTokens.toLocaleString()} tokens embedded
          {repo.commitRef ? ` · ${repo.commitRef.slice(0, 7)}` : ""}
        </p>
      </header>

      {summary && (
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
          <StatCard
            icon={<LayersIcon className="h-3.5 w-3.5" />}
            label="Primary language"
            value={summary.languages[0]?.language ?? "—"}
            detail={
              summary.languages[0] ? `${summary.languages[0].share}% of files` : undefined
            }
          />
          <StatCard
            icon={<RouteIcon className="h-3.5 w-3.5" />}
            label="HTTP routes"
            value={summary.endpointCount ? String(summary.endpointCount) : "none found"}
            detail={summary.endpointCount ? "statically detected" : undefined}
          />
          <StatCard
            icon={<BoxIcon className="h-3.5 w-3.5" />}
            label="Dependencies"
            value={String(summary.dependencies.reduce((sum, d) => sum + d.count, 0) || "—")}
            detail={summary.dependencies[0]?.manifest.split("/").pop()}
          />
          <StatCard
            icon={<SearchIcon className="h-3.5 w-3.5" />}
            label="Entry points"
            value={String(summary.entryPoints.length || "—")}
            detail={summary.entryPoints[0]?.split("/").pop()}
          />
        </div>
      )}

      {summary && summary.languages.length > 1 && (
        <div>
          <div className="flex h-1.5 overflow-hidden rounded-full">
            {summary.languages.slice(0, 6).map((lang, index) => (
              <div
                key={lang.language}
                title={`${lang.language} — ${lang.files} files`}
                style={{
                  width: `${lang.share}%`,
                  background: LANGUAGE_COLORS[index % LANGUAGE_COLORS.length],
                }}
              />
            ))}
          </div>
          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
            {summary.languages.slice(0, 6).map((lang, index) => (
              <span key={lang.language} className="flex items-center gap-1.5 text-[11px] text-ink-muted">
                <span
                  className="h-2 w-2 rounded-full"
                  style={{ background: LANGUAGE_COLORS[index % LANGUAGE_COLORS.length] }}
                />
                {lang.language}
                <span className="text-ink-faint">{lang.share}%</span>
              </span>
            ))}
          </div>
        </div>
      )}

      <div>
        <p className="mb-2 text-[10px] font-medium uppercase tracking-wider text-ink-faint">
          Start with
        </p>
        <div className="grid gap-2 sm:grid-cols-2">
          {questions.map((question) => (
            <button
              key={question}
              type="button"
              onClick={() => onPickQuestion(question)}
              className="group rounded-lg border border-line bg-surface/60 px-3.5 py-2.5 text-left text-[13px] leading-snug text-ink-muted transition hover:border-accent/45 hover:bg-surface-2 hover:text-ink"
            >
              {question}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function StatCard({
  icon,
  label,
  value,
  detail,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <div className="rounded-lg border border-line bg-surface/50 px-3 py-2.5">
      <p className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-ink-faint">
        {icon}
        {label}
      </p>
      <p className="mt-1 truncate text-sm font-medium text-ink">{value}</p>
      {detail && <p className="truncate font-mono text-[10px] text-ink-faint">{detail}</p>}
    </div>
  );
}

const LANGUAGE_COLORS = ["#8b7cf6", "#2dd4bf", "#f5b955", "#82c8ff", "#f87171", "#a3e635"];

/** Starter questions, tailored to what the repo map actually found. */
function buildQuestions(repo: RepoDetail): string[] {
  const questions = ["How does this project work, end to end?"];
  const summary = repo.summary;

  if (summary?.endpointCount) {
    questions.push("What API endpoints does this expose, and what does each one do?");
  }
  if (summary?.entryPoints.length) {
    questions.push(`What happens when \`${summary.entryPoints[0]}\` runs?`);
  }
  questions.push("What are the main external dependencies and what is each used for?");
  questions.push("How is configuration and environment handling done?");
  questions.push("Where are errors handled, and what happens when something fails?");

  return questions.slice(0, 6);
}
