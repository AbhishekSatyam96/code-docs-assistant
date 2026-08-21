"use client";

import { memo, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import type { SourceRef } from "@/lib/types";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  sources?: SourceRef[];
  status?: string | null;
  error?: string | null;
  streaming?: boolean;
  usage?: { totalMs: number; costUsd: number; promptTokens: number } | null;
}

interface Props {
  message: ChatMessage;
  onOpenSource: (source: SourceRef) => void;
}

/**
 * Rewrite bare `[3]` citations into markdown links pointing at a private
 * `#cite-3` scheme, which the link renderer below turns into a pill.
 *
 * Going through markdown's own link syntax means the citation survives inside
 * lists, tables and emphasis without a bespoke inline parser. Fenced code
 * blocks are held out so that array indexing in an example (`items[0]`) is
 * never mistaken for a citation.
 */
function linkifyCitations(markdown: string): string {
  return markdown
    .split(/(```[\s\S]*?```|`[^`\n]*`)/g)
    .map((segment, index) =>
      index % 2 === 1
        ? segment
        : segment.replace(/\[(\d{1,2})\](?!\()/g, "[$1](#cite-$1)"),
    )
    .join("");
}

export const Message = memo(function Message({ message, onOpenSource }: Props) {
  const isUser = message.role === "user";
  const sourcesByIndex = useMemo(
    () => new Map((message.sources ?? []).map((s) => [String(s.index), s])),
    [message.sources],
  );
  const rendered = useMemo(() => linkifyCitations(message.content), [message.content]);

  if (isUser) {
    return (
      <div className="animate-fade-rise flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-md border border-accent/25 bg-accent-dim/60 px-4 py-2.5 text-[0.9375rem] leading-relaxed text-ink">
          {message.content}
        </div>
      </div>
    );
  }

  return (
    <div className="animate-fade-rise space-y-3">
      {message.status && message.streaming && !message.content && (
        <div className="flex items-center gap-2 text-xs text-ink-muted">
          <span className="relative flex h-1.5 w-1.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-70" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-accent" />
          </span>
          {message.status}
        </div>
      )}

      {message.sources && message.sources.length > 0 && (
        <SourceStrip sources={message.sources} onOpenSource={onOpenSource} />
      )}

      {message.content && (
        <div className={`answer ${message.streaming ? "caret" : ""}`}>
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              a({ href, children, ...props }) {
                const citation = href?.startsWith("#cite-")
                  ? sourcesByIndex.get(href.slice(6))
                  : undefined;

                if (!citation) {
                  return (
                    <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
                      {children}
                    </a>
                  );
                }

                return (
                  <button
                    type="button"
                    onClick={() => onOpenSource(citation)}
                    title={`${citation.path}:${citation.startLine}-${citation.endLine}`}
                    className="mx-0.5 inline-flex h-[1.15em] min-w-[1.15em] items-center justify-center rounded border border-accent/40 bg-accent/15 px-1 align-[0.05em] font-mono text-[0.7em] font-semibold text-accent-soft transition hover:bg-accent/30"
                  >
                    {citation.index}
                  </button>
                );
              },
            }}
          >
            {rendered}
          </ReactMarkdown>
        </div>
      )}

      {message.error && (
        <p className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
          {message.error}
        </p>
      )}

      {message.usage && !message.streaming && (
        <p className="font-mono text-[10px] text-ink-faint">
          {(message.usage.totalMs / 1000).toFixed(1)}s ·{" "}
          {message.usage.promptTokens.toLocaleString()} prompt tokens · $
          {message.usage.costUsd.toFixed(4)}
        </p>
      )}
    </div>
  );
});

/**
 * Sources are shown *before* the answer streams in, not after.
 *
 * They arrive from the server as soon as retrieval finishes — a second or so
 * ahead of the first token — so showing them immediately gives the user
 * something real to read during generation, and makes it obvious what evidence
 * the answer is about to be built from.
 */
function SourceStrip({
  sources,
  onOpenSource,
}: {
  sources: SourceRef[];
  onOpenSource: (source: SourceRef) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {sources.map((source) => (
        <button
          key={source.chunkId}
          type="button"
          onClick={() => onOpenSource(source)}
          title={`Retrieved via ${source.via} · score ${source.score.toFixed(4)}`}
          className="group flex items-center gap-1.5 rounded-md border border-line bg-surface/80 py-1 pl-1 pr-2 transition hover:border-accent/50 hover:bg-surface-2"
        >
          <span className="flex h-4 w-4 items-center justify-center rounded bg-surface-3 font-mono text-[10px] font-semibold text-ink-muted group-hover:text-accent-soft">
            {source.index}
          </span>
          <span className="max-w-[190px] truncate font-mono text-[11px] text-ink-muted group-hover:text-ink">
            {source.path.split("/").slice(-2).join("/")}
          </span>
          <span className="font-mono text-[10px] text-ink-faint">
            :{source.startLine}
          </span>
        </button>
      ))}
    </div>
  );
}
