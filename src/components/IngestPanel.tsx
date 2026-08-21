"use client";

import { useRef, useState } from "react";

import { ingestGitHub, ingestUpload } from "@/lib/client/api";
import { INGEST } from "@/lib/config";
import { shouldIndex } from "@/lib/ingest/languages";
import { FolderIcon, GitHubIcon } from "./icons";

interface Props {
  onIngestStarted: (repoId: string) => void;
}

const EXAMPLES = [
  "https://github.com/expressjs/express",
  "https://github.com/tiangolo/fastapi",
  "https://github.com/colinhacks/zod",
];

export function IngestPanel({ onIngestStarted }: Props) {
  const [mode, setMode] = useState<"github" | "upload">("github");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [readProgress, setReadProgress] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  async function submitGitHub(event: React.FormEvent) {
    event.preventDefault();
    if (!url.trim() || busy) return;

    setBusy(true);
    setError(null);
    try {
      onIngestStarted(await ingestGitHub(url.trim()));
      setUrl("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  /**
   * Read a picked folder in the browser and upload only the indexable files.
   *
   * Filtering here with the *same* `shouldIndex` rules the server uses is the
   * point: a `node_modules` directory is often 95% of a project by file count,
   * and uploading it just to have the server throw it away would turn a
   * two-second action into a multi-minute one. The server re-checks anyway —
   * this is an optimisation, not the security boundary.
   */
  async function handleFiles(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return;

    setBusy(true);
    setError(null);

    try {
      const all = Array.from(fileList);
      const rootName =
        all[0]?.webkitRelativePath?.split("/")[0] || all[0]?.name || "Local folder";

      const candidates = all.filter((file) => {
        const relative = (file.webkitRelativePath || file.name)
          .split("/")
          .slice(1)
          .join("/");
        return (
          relative &&
          file.size <= INGEST.maxFileBytes &&
          shouldIndex(relative)
        );
      });

      if (candidates.length === 0) {
        setError("No indexable source files in that folder.");
        return;
      }

      const capped = candidates.slice(0, INGEST.maxFiles);
      const payload: Array<{ path: string; content: string }> = [];
      let bytes = 0;

      for (let i = 0; i < capped.length; i++) {
        const file = capped[i];
        if (i % 25 === 0) {
          setReadProgress(`Reading ${i + 1} / ${capped.length} files`);
          // Yield to the event loop so the label actually paints.
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
        const content = await file.text();
        bytes += content.length;
        if (bytes > INGEST.maxTotalBytes) break;
        payload.push({ path: file.webkitRelativePath || file.name, content });
      }

      setReadProgress(`Uploading ${payload.length} files`);
      onIngestStarted(await ingestUpload(rootName, payload));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      setReadProgress(null);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  return (
    <div className="rounded-panel border border-line bg-surface/70 p-3">
      <div className="mb-3 flex gap-1 rounded-lg bg-base/60 p-1">
        {(
          [
            ["github", "GitHub", GitHubIcon],
            ["upload", "Folder", FolderIcon],
          ] as const
        ).map(([value, label, IconComponent]) => (
          <button
            key={value}
            type="button"
            onClick={() => setMode(value)}
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition ${
              mode === value
                ? "bg-surface-3 text-ink shadow-sm"
                : "text-ink-faint hover:text-ink-muted"
            }`}
          >
            <IconComponent className="h-3.5 w-3.5" />
            {label}
          </button>
        ))}
      </div>

      {mode === "github" ? (
        <form onSubmit={submitGitHub} className="space-y-2">
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="github.com/owner/repo"
            spellCheck={false}
            disabled={busy}
            className="w-full rounded-lg border border-line bg-base/70 px-3 py-2 font-mono text-xs text-ink placeholder:text-ink-faint focus:border-accent/60 focus:outline-none disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={busy || !url.trim()}
            className="w-full rounded-lg bg-accent px-3 py-2 text-xs font-semibold text-white transition hover:bg-accent-soft disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? "Starting…" : "Index repository"}
          </button>

          <div className="pt-1">
            <p className="mb-1.5 text-[10px] uppercase tracking-wider text-ink-faint">
              Try one
            </p>
            <div className="flex flex-wrap gap-1">
              {EXAMPLES.map((example) => (
                <button
                  key={example}
                  type="button"
                  onClick={() => setUrl(example)}
                  className="rounded-md border border-line bg-base/50 px-1.5 py-1 font-mono text-[10px] text-ink-muted transition hover:border-accent/40 hover:text-ink"
                >
                  {example.replace("https://github.com/", "")}
                </button>
              ))}
            </div>
          </div>
        </form>
      ) : (
        <div className="space-y-2">
          <input
            ref={fileInput}
            type="file"
            // Non-standard but universally supported; the React types don't
            // know about it, hence the cast.
            {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
            multiple
            onChange={(e) => handleFiles(e.target.files)}
            className="hidden"
            id="folder-input"
          />
          <label
            htmlFor="folder-input"
            className="flex cursor-pointer flex-col items-center gap-1.5 rounded-lg border border-dashed border-line-strong bg-base/40 px-3 py-6 text-center transition hover:border-accent/50 hover:bg-base/70"
          >
            <FolderIcon className="h-5 w-5 text-ink-faint" />
            <span className="text-xs font-medium text-ink-muted">
              Choose a project folder
            </span>
            <span className="text-[10px] text-ink-faint">
              Build output and dependencies are skipped automatically
            </span>
          </label>
        </div>
      )}

      {readProgress && (
        <p className="mt-2 animate-pulse-soft text-[11px] text-ink-muted">{readProgress}</p>
      )}
      {error && (
        <p className="mt-2 rounded-md border border-danger/30 bg-danger/10 px-2 py-1.5 text-[11px] text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
