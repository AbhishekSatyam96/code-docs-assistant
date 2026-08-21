"use client";

import type { RepoSummary } from "@/lib/types";
import { IngestPanel } from "./IngestPanel";
import {
  AlertIcon,
  BoxIcon,
  FolderIcon,
  GitHubIcon,
  PulseIcon,
  SparkIcon,
  TrashIcon,
} from "./icons";

interface Props {
  repos: RepoSummary[];
  activeRepoId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onIngestStarted: (id: string) => void;
  onOpenTraces: () => void;
}

export function Sidebar({
  repos,
  activeRepoId,
  onSelect,
  onDelete,
  onIngestStarted,
  onOpenTraces,
}: Props) {
  return (
    <aside className="flex w-[304px] shrink-0 flex-col border-r border-line bg-surface/40">
      <div className="flex items-center gap-2.5 border-b border-line px-4 py-3.5">
        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent/15 ring-1 ring-accent/30">
          <SparkIcon className="h-4 w-4 text-accent-soft" />
        </div>
        <div className="leading-tight">
          <h1 className="text-[13px] font-semibold text-ink">Code Docs Assistant</h1>
          <p className="text-[10px] text-ink-faint">Ask questions about any codebase</p>
        </div>
      </div>

      <div className="p-3">
        <IngestPanel onIngestStarted={onIngestStarted} />
      </div>

      <div className="flex min-h-0 flex-1 flex-col px-3 pb-3">
        <p className="mb-2 px-1 text-[10px] font-medium uppercase tracking-wider text-ink-faint">
          Indexed ({repos.length})
        </p>

        <div className="min-h-0 flex-1 space-y-1 overflow-y-auto pr-0.5">
          {repos.length === 0 && (
            <p className="px-1 py-6 text-center text-[11px] leading-relaxed text-ink-faint">
              Nothing indexed yet.
              <br />
              Paste a GitHub URL above to begin.
            </p>
          )}

          {repos.map((repo) => (
            <RepoRow
              key={repo.id}
              repo={repo}
              active={repo.id === activeRepoId}
              onSelect={() => onSelect(repo.id)}
              onDelete={() => onDelete(repo.id)}
            />
          ))}
        </div>
      </div>

      <button
        type="button"
        onClick={onOpenTraces}
        className="flex items-center gap-2 border-t border-line px-4 py-3 text-left text-xs text-ink-muted transition hover:bg-surface-2 hover:text-ink"
      >
        <PulseIcon className="h-4 w-4" />
        Observability
        <span className="ml-auto text-[10px] text-ink-faint">traces &amp; cost</span>
      </button>
    </aside>
  );
}

function RepoRow({
  repo,
  active,
  onSelect,
  onDelete,
}: {
  repo: RepoSummary;
  active: boolean;
  onSelect: () => void;
  onDelete: () => void;
}) {
  const indexing = repo.status === "queued" || repo.status === "indexing";
  const SourceIcon = repo.sourceType === "github" ? GitHubIcon : FolderIcon;

  return (
    <div
      className={`group relative overflow-hidden rounded-lg border transition ${
        active
          ? "border-accent/40 bg-accent-dim/40"
          : "border-transparent hover:border-line hover:bg-surface-2/60"
      }`}
    >
      <button
        type="button"
        onClick={onSelect}
        disabled={repo.status === "failed"}
        className="w-full px-2.5 py-2 text-left disabled:cursor-not-allowed"
      >
        <div className="flex items-center gap-2">
          <SourceIcon
            className={`h-3.5 w-3.5 shrink-0 ${active ? "text-accent-soft" : "text-ink-faint"}`}
          />
          <span className="min-w-0 flex-1 truncate text-xs font-medium text-ink">
            {repo.name}
          </span>
          <StatusDot status={repo.status} />
        </div>

        <p className="mt-1 pl-5 font-mono text-[10px] text-ink-faint">
          {repo.status === "ready" ? (
            <>
              {repo.fileCount.toLocaleString()} files ·{" "}
              {repo.chunkCount.toLocaleString()} chunks
              {repo.commitRef ? ` · ${repo.commitRef.slice(0, 7)}` : ""}
            </>
          ) : (
            repo.statusDetail ?? repo.status
          )}
        </p>

        {indexing && (
          <div className="mt-1.5 ml-5 h-0.5 overflow-hidden rounded-full bg-surface-3">
            <div
              className="h-full rounded-full bg-accent transition-[width] duration-500"
              style={{ width: `${Math.max(4, Math.round(repo.progress * 100))}%` }}
            />
          </div>
        )}
      </button>

      {!indexing && (
        <button
          type="button"
          onClick={onDelete}
          aria-label={`Delete ${repo.name}`}
          className="absolute right-1.5 top-1.5 rounded p-1 text-ink-faint opacity-0 transition hover:bg-danger/15 hover:text-danger focus-visible:opacity-100 group-hover:opacity-100"
        >
          <TrashIcon className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}

function StatusDot({ status }: { status: RepoSummary["status"] }) {
  if (status === "failed") return <AlertIcon className="h-3.5 w-3.5 shrink-0 text-danger" />;
  if (status === "ready") return <BoxIcon className="h-3.5 w-3.5 shrink-0 text-ok/70" />;
  return (
    <span className="relative flex h-2 w-2 shrink-0">
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-60" />
      <span className="relative inline-flex h-2 w-2 rounded-full bg-accent" />
    </span>
  );
}
