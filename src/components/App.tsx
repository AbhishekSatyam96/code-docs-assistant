"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { ChatPanel } from "@/components/ChatPanel";
import { CodeDrawer } from "@/components/CodeDrawer";
import type { ChatMessage } from "@/components/Message";
import { Sidebar } from "@/components/Sidebar";
import { TraceDrawer } from "@/components/TraceDrawer";
import { deleteRepo, getRepo, listRepos, streamAnswer } from "@/lib/client/api";
import type { RepoDetail, RepoSummary, SourceRef } from "@/lib/types";

interface Props {
  /** Rendered on the server so the sidebar is populated on first paint. */
  initialRepos: RepoSummary[];
}

export function App({ initialRepos }: Props) {
  const [repos, setRepos] = useState<RepoSummary[]>(initialRepos);
  const [activeId, setActiveId] = useState<string | null>(
    () => initialRepos.find((r) => r.status === "ready")?.id ?? null,
  );
  const [activeRepo, setActiveRepo] = useState<RepoDetail | null>(null);
  const [messagesByRepo, setMessagesByRepo] = useState<Record<string, ChatMessage[]>>({});
  const [busy, setBusy] = useState(false);
  const [openSource, setOpenSource] = useState<SourceRef | null>(null);
  const [tracesOpen, setTracesOpen] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const inFlightRef = useRef(false);
  const messages = activeId ? (messagesByRepo[activeId] ?? []) : [];

  const refreshRepos = useCallback(async () => {
    try {
      const next = await listRepos();
      setRepos(next);
      setActiveId((current) => current ?? next.find((r) => r.status === "ready")?.id ?? null);
    } catch {
      // Transient network failures during polling are not worth surfacing.
    }
  }, []);

  /**
   * Poll only while something is actually indexing.
   *
   * A fixed interval would keep a tab hitting the server forever for no
   * reason; this stops the moment every repo settles and restarts on the next
   * ingestion. There is no fetch on mount — the server already supplied the
   * list.
   */
  useEffect(() => {
    const working = repos.some((r) => r.status === "queued" || r.status === "indexing");
    if (!working) return;
    const timer = setInterval(() => void refreshRepos(), 1_200);
    return () => clearInterval(timer);
  }, [repos, refreshRepos]);

  // Load full detail (repo map summary) whenever the selection or its status changes.
  const activeStatus = repos.find((r) => r.id === activeId)?.status;
  useEffect(() => {
    if (!activeId) return;
    let cancelled = false;
    getRepo(activeId)
      .then((detail) => {
        if (!cancelled) setActiveRepo(detail);
      })
      .catch(() => {
        if (!cancelled) setActiveRepo(null);
      });
    return () => {
      cancelled = true;
    };
  }, [activeId, activeStatus]);

  /**
   * Guard against showing the previous repository's details for a frame while
   * the newly selected one is still loading.
   */
  const visibleRepo = activeRepo && activeRepo.id === activeId ? activeRepo : null;

  const updateMessages = useCallback(
    (repoId: string, updater: (previous: ChatMessage[]) => ChatMessage[]) => {
      setMessagesByRepo((state) => ({ ...state, [repoId]: updater(state[repoId] ?? []) }));
    },
    [],
  );

  const handleAsk = useCallback(
    async (question: string) => {
      // `busy` is React state, so two submits in the same tick would both read
      // it as false and fire two requests — double latency, double cost, two
      // interleaved streams into one bubble. The ref flips synchronously.
      if (!activeId || busy || inFlightRef.current) return;
      inFlightRef.current = true;
      const repoId = activeId;

      const userMessage: ChatMessage = {
        id: `u-${Date.now()}`,
        role: "user",
        content: question,
      };
      const assistantId = `a-${Date.now()}`;
      const assistantMessage: ChatMessage = {
        id: assistantId,
        role: "assistant",
        content: "",
        sources: [],
        status: "Thinking…",
        streaming: true,
      };

      // Snapshot history *before* the new turn so the server sees the prior
      // conversation, not a half-written assistant reply.
      const history = (messagesByRepo[repoId] ?? [])
        .filter((m) => !m.error)
        .map((m) => ({ role: m.role, content: m.content }));

      updateMessages(repoId, (previous) => [...previous, userMessage, assistantMessage]);
      setBusy(true);

      const patch = (changes: Partial<ChatMessage>) =>
        updateMessages(repoId, (previous) =>
          previous.map((m) => (m.id === assistantId ? { ...m, ...changes } : m)),
        );

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        let buffered = "";
        await streamAnswer(
          { repoId, question, history },
          (event) => {
            switch (event.type) {
              case "status":
                patch({ status: event.stage });
                break;
              case "sources":
                patch({ sources: event.sources });
                break;
              case "delta":
                buffered += event.text;
                patch({ content: buffered, status: null });
                break;
              case "done":
                patch({ streaming: false, status: null, usage: event.usage });
                break;
              case "error":
                patch({ streaming: false, status: null, error: event.message });
                break;
            }
          },
          controller.signal,
        );
      } catch (error) {
        if ((error as Error).name === "AbortError") {
          patch({ streaming: false, status: null });
        } else {
          patch({ streaming: false, status: null, error: (error as Error).message });
        }
      } finally {
        setBusy(false);
        inFlightRef.current = false;
        abortRef.current = null;
      }
    },
    [activeId, busy, messagesByRepo, updateMessages],
  );

  const handleDelete = useCallback(
    async (id: string) => {
      await deleteRepo(id);
      setMessagesByRepo((state) => {
        const next = { ...state };
        delete next[id];
        return next;
      });
      setActiveId((current) => (current === id ? null : current));
      void refreshRepos();
    },
    [refreshRepos],
  );

  return (
    <div className="relative flex h-screen overflow-hidden">
      <div className="app-backdrop pointer-events-none absolute inset-0 -z-10" />

      <Sidebar
        repos={repos}
        activeRepoId={activeId}
        onSelect={setActiveId}
        onDelete={handleDelete}
        onIngestStarted={(id) => {
          setActiveId(id);
          void refreshRepos();
        }}
        onOpenTraces={() => setTracesOpen(true)}
      />

      <main className="flex min-w-0 flex-1 flex-col">
        <ChatPanel
          repo={visibleRepo}
          messages={messages}
          busy={busy}
          onAsk={handleAsk}
          onStop={() => abortRef.current?.abort()}
          onOpenSource={setOpenSource}
        />
      </main>

      {/*
        `key` remounts the drawer for each citation, so it starts from a clean
        loading state instead of having to reset state inside an effect.
      */}
      {activeId && openSource && (
        <CodeDrawer
          key={openSource.chunkId}
          repoId={activeId}
          source={openSource}
          onClose={() => setOpenSource(null)}
        />
      )}

      {tracesOpen && <TraceDrawer onClose={() => setTracesOpen(false)} />}
    </div>
  );
}
