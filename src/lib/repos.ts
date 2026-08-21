import "server-only";

import { query, tbl } from "@/lib/db";
import type { RepoSummary } from "@/lib/types";

/**
 * Shared by the server-rendered page and `GET /api/repos`.
 *
 * The page renders the first list directly from Postgres so there is no
 * fetch-on-mount flash; the same function backs the polling endpoint the
 * client uses afterwards, so the two paths can never drift apart.
 */
export async function listRepositories(): Promise<RepoSummary[]> {
  const rows = await query<Record<string, unknown>>(
    `SELECT id, name, source_type, source_ref, commit_ref, status, status_detail,
            progress, file_count, chunk_count, created_at
       FROM ${tbl("repositories")} ORDER BY created_at DESC`,
  );

  return rows.map((row) => ({
    id: row.id as string,
    name: row.name as string,
    sourceType: row.source_type as RepoSummary["sourceType"],
    sourceRef: row.source_ref as string,
    commitRef: row.commit_ref as string | null,
    status: row.status as RepoSummary["status"],
    statusDetail: row.status_detail as string | null,
    progress: Number(row.progress),
    fileCount: Number(row.file_count),
    chunkCount: Number(row.chunk_count),
    // BIGINT arrives as a string from `pg` to avoid precision loss past 2^53.
    // These are epoch milliseconds, comfortably inside safe-integer range.
    createdAt: Number(row.created_at),
  }));
}
