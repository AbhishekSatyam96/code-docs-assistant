import type {
  AnswerEvent,
  RepoDetail,
  RepoSummary,
  TraceStats,
  TraceSummary,
} from "@/lib/types";

async function json<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error((body as { error?: string }).error ?? `Request failed (${response.status})`);
  }
  return body as T;
}

export async function listRepos(): Promise<RepoSummary[]> {
  const data = await json<{ repositories: RepoSummary[] }>(await fetch("/api/repos"));
  return data.repositories;
}

export async function getRepo(id: string): Promise<RepoDetail> {
  return json<RepoDetail>(await fetch(`/api/repos/${id}`));
}

export async function ingestGitHub(url: string): Promise<string> {
  const data = await json<{ id: string }>(
    await fetch("/api/repos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceType: "github", url }),
    }),
  );
  return data.id;
}

export async function ingestUpload(
  name: string,
  files: Array<{ path: string; content: string }>,
): Promise<string> {
  const data = await json<{ id: string }>(
    await fetch("/api/repos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceType: "upload", name, files }),
    }),
  );
  return data.id;
}

export async function deleteRepo(id: string): Promise<void> {
  await json(await fetch(`/api/repos/${id}`, { method: "DELETE" }));
}

export async function getFile(
  repoId: string,
  path: string,
): Promise<{ path: string; language: string; content: string; loc: number }> {
  const query = new URLSearchParams({ repoId, path });
  return json(await fetch(`/api/files?${query}`));
}

export async function getTraces(): Promise<{ stats: TraceStats; traces: TraceSummary[] }> {
  return json(await fetch("/api/traces?limit=40"));
}

/**
 * Consume the NDJSON answer stream.
 *
 * The buffering matters: a chunk from the network is not guaranteed to end on
 * a newline, so the tail after the last `\n` is carried forward rather than
 * parsed. Getting this wrong produces intermittent JSON errors that only show
 * up under slow connections, which is a miserable bug to chase later.
 */
export async function streamAnswer(
  body: {
    repoId: string;
    question: string;
    history: Array<{ role: "user" | "assistant"; content: string }>;
  },
  onEvent: (event: AnswerEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error((error as { error?: string }).error ?? "The request failed.");
  }
  if (!response.body) throw new Error("No response stream.");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        onEvent(JSON.parse(line) as AnswerEvent);
      } catch {
        // A single malformed line should not kill an in-flight answer.
      }
    }
  }

  if (buffer.trim()) {
    try {
      onEvent(JSON.parse(buffer) as AnswerEvent);
    } catch {
      /* ignore trailing partial */
    }
  }
}
