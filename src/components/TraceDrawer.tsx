"use client";

import { useCallback, useEffect, useState } from "react";

import { getTraces } from "@/lib/client/api";
import type { TraceStats, TraceSummary } from "@/lib/types";
import { CloseIcon, RefreshIcon } from "./icons";

interface Props {
  onClose: () => void;
}

/**
 * Observability surface.
 *
 * Built into the product rather than left to logs because the thing you most
 * need to see when a RAG answer is wrong — which chunks were retrieved, by
 * which retriever, at what fusion score — is invisible in the answer itself.
 * Being able to open this next to a bad answer turns "the model hallucinated"
 * into "retrieval never returned the file", which are different bugs with
 * different fixes.
 */
/**
 * Mounted only while open (the parent unmounts it on close), so the initial
 * fetch happens once per opening and state never needs resetting.
 */
export function TraceDrawer({ onClose }: Props) {
  const [stats, setStats] = useState<TraceStats | null>(null);
  const [traces, setTraces] = useState<TraceSummary[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const apply = useCallback((data: { stats: TraceStats; traces: TraceSummary[] }) => {
    setStats(data.stats);
    setTraces(data.traces);
    setLoading(false);
  }, []);

  useEffect(() => {
    let cancelled = false;
    getTraces()
      .then((data) => {
        if (!cancelled) apply(data);
      })
      .catch(() => {
        // The panel is diagnostic; a failed load just shows the empty state.
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [apply]);

  const refresh = useCallback(() => {
    setLoading(true);
    getTraces()
      .then(apply)
      .catch(() => setLoading(false));
  }, [apply]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <>
      <div
        className="fixed inset-0 z-40 bg-black/50 backdrop-blur-[2px]"
        onClick={onClose}
        aria-hidden="true"
      />
      <aside className="animate-fade-rise fixed right-0 top-0 z-50 flex h-full w-full max-w-2xl flex-col border-l border-line bg-surface shadow-2xl">
        <header className="flex items-center gap-3 border-b border-line px-4 py-3">
          <div className="flex-1">
            <h2 className="text-sm font-semibold text-ink">Observability</h2>
            <p className="text-[11px] text-ink-faint">
              Per-question traces: retrieval, latency, tokens, cost
            </p>
          </div>
          <button
            type="button"
            onClick={refresh}
            aria-label="Refresh"
            className="rounded-md border border-line p-1.5 text-ink-muted transition hover:border-accent/40 hover:text-ink"
          >
            <RefreshIcon className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md border border-line p-1.5 text-ink-muted transition hover:border-accent/40 hover:text-ink"
          >
            <CloseIcon className="h-3.5 w-3.5" />
          </button>
        </header>

        {stats && (
          <div className="grid grid-cols-3 gap-2 border-b border-line px-4 py-3 sm:grid-cols-6">
            <Metric label="Questions" value={String(stats.total)} />
            <Metric label="Answered" value={String(stats.answered)} tone="ok" />
            <Metric
              label="Refused"
              value={String(stats.refused)}
              tone={stats.refused ? "warn" : undefined}
            />
            <Metric label="p50" value={`${(stats.p50Ms / 1000).toFixed(1)}s`} />
            <Metric label="p95" value={`${(stats.p95Ms / 1000).toFixed(1)}s`} />
            <Metric label="Spend" value={`$${stats.totalCostUsd.toFixed(3)}`} />
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto">
          {traces.length === 0 && (
            <p className="p-8 text-center text-xs text-ink-faint">
              No questions answered yet.
            </p>
          )}

          {traces.map((trace) => (
            <div key={trace.id} className="border-b border-line/60">
              <button
                type="button"
                onClick={() => setExpanded(expanded === trace.id ? null : trace.id)}
                className="w-full px-4 py-2.5 text-left transition hover:bg-surface-2/60"
              >
                <div className="flex items-start gap-2">
                  <StatusPill status={trace.status} />
                  <p className="min-w-0 flex-1 truncate text-xs text-ink">
                    {trace.question}
                  </p>
                  <span className="shrink-0 font-mono text-[10px] text-ink-faint">
                    {(trace.totalMs / 1000).toFixed(1)}s
                  </span>
                </div>
                <p className="mt-1 flex flex-wrap gap-x-3 pl-[72px] font-mono text-[10px] text-ink-faint">
                  <span>{trace.retrieved.length} chunks</span>
                  <span>retrieval {trace.retrievalMs}ms</span>
                  <span>llm {trace.llmMs}ms</span>
                  <span>{trace.promptTokens.toLocaleString()} in</span>
                  <span>{trace.completionTokens.toLocaleString()} out</span>
                  <span>${trace.costUsd.toFixed(4)}</span>
                </p>
              </button>

              {expanded === trace.id && (
                <div className="space-y-2 bg-base/50 px-4 pb-3 pt-1">
                  {trace.resolvedQuestion &&
                    trace.resolvedQuestion !== trace.question && (
                      <div>
                        <p className="text-[10px] uppercase tracking-wide text-ink-faint">
                          Rewritten for retrieval
                        </p>
                        <p className="font-mono text-[11px] text-ink-muted">
                          {trace.resolvedQuestion}
                        </p>
                      </div>
                    )}

                  <div>
                    <p className="mb-1 text-[10px] uppercase tracking-wide text-ink-faint">
                      Retrieved context
                    </p>
                    <div className="space-y-0.5">
                      {trace.retrieved.map((chunk, index) => (
                        <div
                          key={`${chunk.chunkId}-${index}`}
                          className="flex items-center gap-2 font-mono text-[10.5px]"
                        >
                          <span className="w-4 text-right text-ink-faint">{index + 1}</span>
                          <span className="min-w-0 flex-1 truncate text-ink-muted">
                            {chunk.path}:{chunk.lines}
                          </span>
                          <span className="rounded border border-line px-1 text-ink-faint">
                            {chunk.via}
                          </span>
                          <span className="w-14 text-right text-ink-faint">
                            {chunk.score.toFixed(4)}
                          </span>
                        </div>
                      ))}
                      {trace.retrieved.length === 0 && (
                        <p className="text-[11px] text-ink-faint">Nothing retrieved.</p>
                      )}
                    </div>
                  </div>

                  <p className="font-mono text-[10px] text-ink-faint">
                    {trace.model} · trace {trace.id} ·{" "}
                    {new Date(trace.createdAt).toLocaleTimeString()}
                  </p>
                </div>
              )}
            </div>
          ))}
        </div>
      </aside>
    </>
  );
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "ok" | "warn";
}) {
  const color =
    tone === "ok" ? "text-ok" : tone === "warn" ? "text-warn" : "text-ink";
  return (
    <div>
      <p className="text-[9px] uppercase tracking-wide text-ink-faint">{label}</p>
      <p className={`font-mono text-sm ${color}`}>{value}</p>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const styles: Record<string, string> = {
    answered: "border-ok/30 bg-ok/10 text-ok",
    refused: "border-warn/30 bg-warn/10 text-warn",
    no_context: "border-warn/30 bg-warn/10 text-warn",
    error: "border-danger/30 bg-danger/10 text-danger",
  };
  return (
    <span
      className={`w-16 shrink-0 rounded border px-1 py-0.5 text-center text-[9px] font-medium uppercase tracking-tight ${
        styles[status] ?? "border-line text-ink-faint"
      }`}
    >
      {status === "no_context" ? "empty" : status}
    </span>
  );
}
