import "server-only";

import zlib from "node:zlib";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Parser } from "tar";

import { INGEST } from "@/lib/config";
import { logger } from "@/lib/observability/logger";
import { looksBinary, shouldIndex } from "./languages";

export interface SourceFile {
  path: string;
  content: string;
  bytes: number;
}

export interface LoadedSource {
  name: string;
  ref: string | null;
  files: SourceFile[];
  skipped: { excluded: number; tooLarge: number; binary: number };
}

export class IngestError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "IngestError";
  }
}

const GITHUB_URL =
  /^https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/(?:tree|blob)\/([^/]+))?\/?$/;

export interface ParsedRepoUrl {
  owner: string;
  repo: string;
  ref: string | null;
}

/**
 * Parse and validate a GitHub URL.
 *
 * The hostname allowlist is a security control, not a convenience: this server
 * fetches whatever URL it is handed, so accepting arbitrary hosts would turn
 * the ingest endpoint into an SSRF primitive pointed at cloud metadata
 * services and internal networks. Only github.com is reachable.
 */
export function parseGitHubUrl(input: string): ParsedRepoUrl {
  const trimmed = input.trim();
  const match = trimmed.match(GITHUB_URL);
  if (!match) {
    throw new IngestError(
      "Expected a GitHub repository URL, e.g. https://github.com/owner/repo",
    );
  }
  const [, owner, repo, ref] = match;
  return { owner, repo, ref: ref ?? null };
}

/**
 * Download a repository as a tarball and read it entirely in memory.
 *
 * Nothing is written to disk, which sidesteps a whole class of extraction
 * vulnerabilities and means the container needs no writable scratch volume.
 * Repos are capped well below memory limits by `INGEST.maxTotalBytes`.
 */
export async function loadGitHubRepo(url: string): Promise<LoadedSource> {
  const { owner, repo, ref } = parseGitHubUrl(url);
  const log = logger.bind({ owner, repo, ref });

  const tarballUrl = ref
    ? `https://api.github.com/repos/${owner}/${repo}/tarball/${encodeURIComponent(ref)}`
    : `https://api.github.com/repos/${owner}/${repo}/tarball`;

  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "code-docs-assistant",
  };
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }

  const response = await fetch(tarballUrl, { headers, redirect: "follow" });

  if (response.status === 404) {
    throw new IngestError(
      `Repository ${owner}/${repo} not found. If it is private, set GITHUB_TOKEN.`,
      404,
    );
  }
  if (response.status === 403) {
    throw new IngestError(
      "GitHub rate limit reached. Set GITHUB_TOKEN to raise the limit.",
      429,
    );
  }
  if (!response.ok || !response.body) {
    throw new IngestError(
      `GitHub returned ${response.status} while downloading the repository.`,
      502,
    );
  }

  const files: SourceFile[] = [];
  const skipped = { excluded: 0, tooLarge: 0, binary: 0 };
  let totalBytes = 0;
  let resolvedRef: string | null = ref;
  let aborted = false;

  const parser = new Parser({
    onReadEntry(entry) {
      if (aborted || entry.type !== "File") {
        entry.resume();
        return;
      }

      // GitHub wraps everything in `owner-repo-sha/`. Strip that prefix, and
      // harvest the short SHA from it so the UI can show what was indexed.
      const raw = String(entry.path);
      const slash = raw.indexOf("/");
      if (slash === -1) {
        entry.resume();
        return;
      }
      if (!resolvedRef) {
        const prefix = raw.slice(0, slash);
        const lastDash = prefix.lastIndexOf("-");
        if (lastDash !== -1) resolvedRef = prefix.slice(lastDash + 1);
      }

      const relativePath = raw.slice(slash + 1);

      if (!isSafePath(relativePath) || !shouldIndex(relativePath)) {
        skipped.excluded++;
        entry.resume();
        return;
      }
      if (files.length >= INGEST.maxFiles) {
        skipped.excluded++;
        entry.resume();
        return;
      }

      const size = Number(entry.size ?? 0);
      if (size > INGEST.maxFileBytes) {
        skipped.tooLarge++;
        entry.resume();
        return;
      }

      const parts: Buffer[] = [];
      entry.on("data", (chunk: Buffer) => parts.push(chunk));
      entry.on("end", () => {
        const buffer = Buffer.concat(parts);
        const content = buffer.toString("utf8");
        if (looksBinary(content)) {
          skipped.binary++;
          return;
        }
        totalBytes += buffer.byteLength;
        if (totalBytes > INGEST.maxTotalBytes) {
          aborted = true;
          return;
        }
        files.push({ path: relativePath, content, bytes: buffer.byteLength });
      });
    },
  });

  await pipeline(
    Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
    zlib.createGunzip(),
    parser,
  );

  if (files.length === 0) {
    throw new IngestError(
      "No indexable source files were found in that repository.",
      422,
    );
  }

  log.info("github repo downloaded", {
    files: files.length,
    bytes: totalBytes,
    skipped,
  });

  return { name: `${owner}/${repo}`, ref: resolvedRef, files, skipped };
}

/**
 * Build a source from browser-uploaded files (folder picker).
 *
 * The same `shouldIndex` rules run on the client before upload, so this is the
 * second half of a defence in depth rather than the only check — a crafted
 * request must not be able to smuggle in paths the UI would have filtered.
 */
export function loadUploadedFiles(
  name: string,
  entries: Array<{ path: string; content: string }>,
): LoadedSource {
  const files: SourceFile[] = [];
  const skipped = { excluded: 0, tooLarge: 0, binary: 0 };
  let totalBytes = 0;

  for (const entry of entries) {
    const path = normaliseUploadPath(entry.path);
    if (!isSafePath(path) || !shouldIndex(path)) {
      skipped.excluded++;
      continue;
    }
    const bytes = Buffer.byteLength(entry.content, "utf8");
    if (bytes > INGEST.maxFileBytes) {
      skipped.tooLarge++;
      continue;
    }
    if (looksBinary(entry.content)) {
      skipped.binary++;
      continue;
    }
    totalBytes += bytes;
    if (totalBytes > INGEST.maxTotalBytes || files.length >= INGEST.maxFiles) break;

    files.push({ path, content: entry.content, bytes });
  }

  if (files.length === 0) {
    throw new IngestError("No indexable source files were found in that folder.", 422);
  }

  return { name, ref: null, files, skipped };
}

/** Drop the top-level folder the browser prepends to `webkitRelativePath`. */
function normaliseUploadPath(path: string): string {
  const cleaned = path.replace(/\\/g, "/").replace(/^\.\//, "");
  const slash = cleaned.indexOf("/");
  return slash === -1 ? cleaned : cleaned.slice(slash + 1);
}

/**
 * Reject absolute paths, `..` traversal, and NUL injection.
 *
 * Nothing here is written to disk today, but these paths are used as database
 * keys and rendered in the UI, and the cost of getting this wrong the day
 * someone adds a disk cache is high enough to justify the check now.
 */
export function isSafePath(path: string): boolean {
  if (!path || path.length > 400) return false;
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) return false;
  if (path.includes("\u0000")) return false;
  return !path.split("/").some((segment) => segment === ".." || segment === "");
}
