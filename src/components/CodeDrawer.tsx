"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import hljs from "highlight.js/lib/common";

import { getFile } from "@/lib/client/api";
import type { SourceRef } from "@/lib/types";
import { CloseIcon, CopyIcon, FileIcon } from "./icons";

interface Props {
  repoId: string;
  source: SourceRef;
  onClose: () => void;
}

/**
 * Slide-over viewer for a cited file.
 *
 * A citation is only trustworthy if it can be checked, so this shows the whole
 * file with the cited range highlighted and scrolled into view — not just the
 * retrieved slice. Seeing the surrounding code is usually how you notice the
 * model has over-read a fragment.
 */
export function CodeDrawer({ repoId, source, onClose }: Props) {
  // The parent remounts this component per citation (via `key`), so state
  // starts fresh every time and the effect below never has to reset it.
  const [file, setFile] = useState<{ content: string; language: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const highlightRef = useRef<HTMLDivElement>(null);

  const loading = !file && !error;

  useEffect(() => {
    let cancelled = false;

    getFile(repoId, source.path)
      .then((data) => {
        if (!cancelled) setFile({ content: data.content, language: data.language });
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message);
      });

    return () => {
      cancelled = true;
    };
  }, [repoId, source.path]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Scroll the cited range into view once the content has painted.
  useEffect(() => {
    if (!file || !highlightRef.current) return;
    highlightRef.current.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [file]);

  const lines = useMemo(() => {
    if (!file) return [];
    // Highlight the file as a whole rather than line by line: per-line
    // highlighting loses multi-line constructs like block comments and
    // template literals, which then bleed the wrong colour down the file.
    let html: string;
    try {
      html = hljs.getLanguage(file.language)
        ? hljs.highlight(file.content, { language: file.language, ignoreIllegals: true }).value
        : hljs.highlightAuto(file.content).value;
    } catch {
      html = escapeHtml(file.content);
    }
    return splitHighlightedLines(html);
  }, [file]);

  return (
    <>
      <div
        className="fixed inset-0 z-40 bg-black/50 backdrop-blur-[2px]"
        onClick={onClose}
        aria-hidden="true"
      />
      <aside className="animate-fade-rise fixed right-0 top-0 z-50 flex h-full w-full max-w-3xl flex-col border-l border-line bg-surface shadow-2xl">
        <header className="flex items-start gap-3 border-b border-line px-4 py-3">
          <FileIcon className="mt-0.5 h-4 w-4 shrink-0 text-ink-faint" />
          <div className="min-w-0 flex-1">
            <p className="truncate font-mono text-sm text-ink">{source.path}</p>
            <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[11px] text-ink-faint">
              <span>
                lines {source.startLine}–{source.endLine}
              </span>
              {source.symbol && <span className="text-accent-soft">{source.symbol}</span>}
              <span className="rounded border border-line px-1">via {source.via}</span>
              <span>score {source.score.toFixed(4)}</span>
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              if (!file) return;
              const excerpt = file.content
                .split("\n")
                .slice(source.startLine - 1, source.endLine)
                .join("\n");
              void navigator.clipboard.writeText(excerpt);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
            className="rounded-md border border-line px-2 py-1 text-[11px] text-ink-muted transition hover:border-accent/40 hover:text-ink"
          >
            {copied ? "Copied" : <CopyIcon className="h-3.5 w-3.5" />}
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md border border-line p-1 text-ink-muted transition hover:border-accent/40 hover:text-ink"
          >
            <CloseIcon className="h-3.5 w-3.5" />
          </button>
        </header>

        <div className="flex-1 overflow-auto bg-[#0d1017]">
          {loading && (
            <div className="space-y-2 p-4">
              {Array.from({ length: 14 }).map((_, i) => (
                <div key={i} className="shimmer h-3 rounded bg-surface-2" style={{ width: `${40 + ((i * 13) % 50)}%` }} />
              ))}
            </div>
          )}

          {error && <p className="p-4 text-sm text-danger">{error}</p>}

          {file && (
            <pre className="min-w-max py-3 font-mono text-[12.5px] leading-[1.65]">
              {lines.map((html, index) => {
                const lineNumber = index + 1;
                const inRange =
                  lineNumber >= source.startLine && lineNumber <= source.endLine;
                const isFirstInRange = lineNumber === source.startLine;

                return (
                  <div
                    key={lineNumber}
                    ref={isFirstInRange ? highlightRef : undefined}
                    className={`flex ${
                      inRange
                        ? "bg-accent/[0.11] shadow-[inset_2px_0_0_var(--color-accent)]"
                        : ""
                    }`}
                  >
                    <span className="sticky left-0 w-12 shrink-0 select-none bg-[#0d1017] pr-3 text-right text-[11px] text-ink-faint/60">
                      {lineNumber}
                    </span>
                    <code
                      className="hljs flex-1 pr-4"
                      dangerouslySetInnerHTML={{ __html: html || "&nbsp;" }}
                    />
                  </div>
                );
              })}
            </pre>
          )}
        </div>
      </aside>
    </>
  );
}

/**
 * Split highlight.js output into per-line HTML, reopening any spans that were
 * still open at the line break.
 *
 * highlight.js emits a single HTML string in which a multi-line token (a block
 * comment, a template literal) is one `<span>` crossing several `\n`. Naively
 * splitting on newlines produces unbalanced tags and the browser's error
 * recovery smears the highlight over the rest of the file. Tracking the open
 * tag stack and re-emitting it per line keeps every line independently valid,
 * which is what the line-number layout requires.
 */
function splitHighlightedLines(html: string): string[] {
  const lines: string[] = [];
  const openTags: string[] = [];
  let current = "";

  const tokenPattern = /(<\/?span[^>]*>)|(\n)|([^<\n]+)|(<)/g;
  let match: RegExpExecArray | null;

  while ((match = tokenPattern.exec(html)) !== null) {
    const [, tag, newline, text, stray] = match;

    if (tag) {
      current += tag;
      if (tag.startsWith("</")) openTags.pop();
      else openTags.push(tag);
    } else if (newline) {
      lines.push(current + "</span>".repeat(openTags.length));
      current = openTags.join("");
    } else {
      current += text ?? stray ?? "";
    }
  }

  lines.push(current + "</span>".repeat(openTags.length));
  return lines;
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
}
