"use client";

import { useEffect, useRef, useState } from "react";

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
  /** Rejects if the delete failed, so the row can show why. */
  onDelete: (id: string) => Promise<void>;
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
  onDelete: () => Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const indexing = repo.status === "queued" || repo.status === "indexing";
  const SourceIcon = repo.sourceType === "github" ? GitHubIcon : FolderIcon;

  const runDelete = async () => {
    setDeleting(true);
    setError(null);
    try {
      await onDelete();
      // Deliberately not resetting `deleting` on success. The row unmounts when
      // the refreshed list arrives, and clearing it first would flash the live
      // row back for a frame.
    } catch (failure) {
      setError((failure as Error).message);
      setDeleting(false);
      setConfirming(false);
    }
  };

  if (confirming || deleting) {
    return (
      <ConfirmDelete
        repo={repo}
        indexing={indexing}
        deleting={deleting}
        onConfirm={runDelete}
        onCancel={() => setConfirming(false)}
      />
    );
  }

  return (
    <div
      className={`relative overflow-hidden rounded-lg border transition ${
        active
          ? "border-accent/40 bg-accent-dim/40"
          : "border-transparent hover:border-line hover:bg-surface-2/60"
      }`}
    >
      <button
        type="button"
        onClick={onSelect}
        disabled={repo.status === "failed"}
        // `pr-10` reserves the lane the delete chip sits in (8px inset + a 28px
        // chip). The button is always visible rather than revealed on hover:
        // hover reveal has no equivalent on touch, and a destructive action
        // nobody can find is the same as not having one.
        className="w-full py-2 pr-10 pl-2.5 text-left disabled:cursor-not-allowed"
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

        {error && (
          <p className="mt-1 pl-5 text-[10px] leading-snug text-danger">{error}</p>
        )}
      </button>

      {/*
        Shown while indexing too. Ingestion can die mid-flight on serverless and
        leave a row stuck in `indexing` forever; hiding delete in that state made
        exactly the rows you most want rid of the ones you could not remove.

        Drawn as a bordered chip rather than a bare glyph. `text-ink-faint` is a
        ~1.9:1 contrast against these surfaces — under the 3:1 WCAG floor for
        interactive controls — so a faint 14px outline icon was invisible in
        practice even though it was in the DOM. `ink-muted` on its own surface
        clears 6:1 and reads as a button rather than as decoration.
      */}
      <button
        type="button"
        onClick={() => setConfirming(true)}
        aria-label={indexing ? `Stop indexing and delete ${repo.name}` : `Delete ${repo.name}`}
        title={indexing ? "Stop indexing and delete" : "Delete"}
        className="absolute top-1/2 right-2 -translate-y-1/2 rounded-md border border-line bg-surface-2 p-1.5 text-ink-muted transition hover:border-danger/50 hover:bg-danger/15 hover:text-danger focus-visible:ring-1 focus-visible:ring-danger/60 focus-visible:outline-none"
      >
        <TrashIcon className="h-4 w-4" strokeWidth={1.7} />
      </button>
    </div>
  );
}

/**
 * Two-step confirmation, inline rather than `window.confirm`.
 *
 * A native dialog would be one line, but it cannot say *what* is being lost —
 * and the cost here is not obvious from the row: deleting drops every chunk and
 * embedding, so getting the repository back means paying to re-embed it.
 */
function ConfirmDelete({
  repo,
  indexing,
  deleting,
  onConfirm,
  onCancel,
}: {
  repo: RepoSummary;
  indexing: boolean;
  deleting: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const confirmRef = useRef<HTMLButtonElement>(null);

  // Focus the destructive button so the confirmation is reachable without a
  // mouse, and so Escape below has somewhere to fire from.
  useEffect(() => {
    confirmRef.current?.focus();
  }, []);

  return (
    <div
      onKeyDown={(event) => {
        if (event.key === "Escape" && !deleting) {
          event.stopPropagation();
          onCancel();
        }
      }}
      className="rounded-lg border border-danger/40 bg-danger/10 px-2.5 py-2"
    >
      <p className="text-[11px] leading-snug text-ink">
        Delete <span className="font-medium break-all">{repo.name}</span>?
      </p>
      <p className="mt-0.5 text-[10px] leading-snug text-ink-faint">
        {indexing
          ? "Indexing stops and nothing is kept."
          : `${repo.chunkCount.toLocaleString()} chunks are removed. Re-indexing costs another embedding run.`}
      </p>

      <div className="mt-2 flex gap-1.5">
        <button
          ref={confirmRef}
          type="button"
          onClick={onConfirm}
          disabled={deleting}
          className="rounded bg-danger/20 px-2 py-1 text-[11px] font-medium text-danger transition hover:bg-danger/30 focus-visible:ring-1 focus-visible:ring-danger/60 focus-visible:outline-none disabled:opacity-60"
        >
          {deleting ? "Deleting…" : "Delete"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={deleting}
          className="rounded px-2 py-1 text-[11px] text-ink-muted transition hover:bg-surface-2 hover:text-ink focus-visible:ring-1 focus-visible:ring-line focus-visible:outline-none disabled:opacity-60"
        >
          Cancel
        </button>
      </div>
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
