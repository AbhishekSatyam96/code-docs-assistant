"use client";

import { useEffect, useRef, useState } from "react";

import type { RepoDetail, SourceRef } from "@/lib/types";
import { Message, type ChatMessage } from "./Message";
import { RepoOverview } from "./RepoOverview";
import { SendIcon, StopIcon } from "./icons";

interface Props {
  repo: RepoDetail | null;
  messages: ChatMessage[];
  busy: boolean;
  onAsk: (question: string) => void;
  onStop: () => void;
  onOpenSource: (source: SourceRef) => void;
}

export function ChatPanel({
  repo,
  messages,
  busy,
  onAsk,
  onStop,
  onOpenSource,
}: Props) {
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const pinnedToBottom = useRef(true);

  /**
   * Follow the stream, but stop following the moment the user scrolls up.
   *
   * Auto-scrolling unconditionally is the classic chat-UI bug: the user scrolls
   * back to read a citation and gets yanked to the bottom on the next token.
   */
  useEffect(() => {
    const element = scrollRef.current;
    if (!element || !pinnedToBottom.current) return;
    element.scrollTop = element.scrollHeight;
  }, [messages]);

  function handleScroll() {
    const element = scrollRef.current;
    if (!element) return;
    const distanceFromBottom =
      element.scrollHeight - element.scrollTop - element.clientHeight;
    pinnedToBottom.current = distanceFromBottom < 120;
  }

  function submit() {
    const question = draft.trim();
    if (!question || busy || !repo) return;
    pinnedToBottom.current = true;
    onAsk(question);
    setDraft("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";
  }

  const ready = repo?.status === "ready";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        <div className="mx-auto w-full max-w-3xl px-6 py-6">
          {messages.length === 0 ? (
            <RepoOverview repo={repo} onPickQuestion={(q) => onAsk(q)} />
          ) : (
            <div className="space-y-7">
              {messages.map((message) => (
                <Message
                  key={message.id}
                  message={message}
                  onOpenSource={onOpenSource}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="border-t border-line bg-surface/30 px-6 py-4">
        <div className="mx-auto w-full max-w-3xl">
          <div
            className={`flex items-end gap-2 rounded-xl border bg-surface/80 px-3 py-2 transition ${
              ready ? "border-line focus-within:border-accent/50" : "border-line opacity-60"
            }`}
          >
            <textarea
              ref={textareaRef}
              rows={1}
              value={draft}
              disabled={!ready || busy}
              onChange={(e) => {
                setDraft(e.target.value);
                e.target.style.height = "auto";
                e.target.style.height = `${Math.min(e.target.scrollHeight, 180)}px`;
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submit();
                }
              }}
              placeholder={
                ready
                  ? `Ask about ${repo?.name}…`
                  : repo
                    ? "Waiting for indexing to finish…"
                    : "Index a repository to get started"
              }
              className="max-h-[180px] flex-1 resize-none bg-transparent py-1.5 text-[0.9375rem] text-ink outline-none placeholder:text-ink-faint disabled:cursor-not-allowed"
            />

            {busy ? (
              <button
                type="button"
                onClick={onStop}
                aria-label="Stop generating"
                className="mb-0.5 rounded-lg border border-line bg-surface-3 p-2 text-ink-muted transition hover:text-ink"
              >
                <StopIcon className="h-4 w-4" />
              </button>
            ) : (
              <button
                type="button"
                onClick={submit}
                disabled={!ready || !draft.trim()}
                aria-label="Send"
                className="mb-0.5 rounded-lg bg-accent p-2 text-white transition hover:bg-accent-soft disabled:cursor-not-allowed disabled:bg-surface-3 disabled:text-ink-faint"
              >
                <SendIcon className="h-4 w-4" />
              </button>
            )}
          </div>

          <p className="mt-2 text-center text-[10px] text-ink-faint">
            Answers are grounded in retrieved source and cite the files they came from.
            Verify anything load-bearing.
          </p>
        </div>
      </div>
    </div>
  );
}
