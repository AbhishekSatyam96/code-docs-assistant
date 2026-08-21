import "server-only";

import { getDb } from "@/lib/db";
import type { RepoSummary } from "@/lib/types";

/**
 * Shared by the server-rendered page and `GET /api/repos`.
 *
 * The page renders the first list directly from SQLite so there is no
 * fetch-on-mount flash; the same function backs the polling endpoint the
 * client uses afterwards, so both paths can never drift apart.
 */
export function listRepositories(): RepoSummary[] {
  const rows = getDb()
    .prepare(
      `SELECT id, name, source_type, source_ref, commit_ref, status, status_detail,
              progress, file_count, chunk_count, created_at
       FROM repositories ORDER BY created_at DESC`,
    )
    .all() as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    id: row.id as string,
    name: row.name as string,
    sourceType: row.source_type as RepoSummary["sourceType"],
    sourceRef: row.source_ref as string,
    commitRef: row.commit_ref as string | null,
    status: row.status as RepoSummary["status"],
    statusDetail: row.status_detail as string | null,
    progress: row.progress as number,
    fileCount: row.file_count as number,
    chunkCount: row.chunk_count as number,
    createdAt: row.created_at as number,
  }));
}
