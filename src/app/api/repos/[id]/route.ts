import { NextResponse } from "next/server";

import { query, tbl } from "@/lib/db";
import { deleteRepository } from "@/lib/ingest/pipeline";
import type { RepoMap } from "@/lib/ingest/repo-map";
import { logger } from "@/lib/observability/logger";

export const dynamic = "force-dynamic";

interface Context {
  params: Promise<{ id: string }>;
}

export async function GET(_request: Request, context: Context) {
  const { id } = await context.params;

  const [row] = await query<Record<string, unknown>>(
    `SELECT id, name, source_type, source_ref, commit_ref, status, status_detail,
            progress, file_count, chunk_count, embed_tokens, repo_map, created_at
       FROM ${tbl("repositories")} WHERE id = $1`,
    [id],
  );

  if (!row) {
    return NextResponse.json({ error: "Repository not found." }, { status: 404 });
  }

  // jsonb is deserialised by `pg`; no JSON.parse needed as it was with SQLite.
  const repoMap = row.repo_map as RepoMap | null;

  return NextResponse.json({
    id: row.id,
    name: row.name,
    sourceType: row.source_type,
    sourceRef: row.source_ref,
    commitRef: row.commit_ref,
    status: row.status,
    statusDetail: row.status_detail,
    progress: Number(row.progress),
    fileCount: Number(row.file_count),
    chunkCount: Number(row.chunk_count),
    embedTokens: Number(row.embed_tokens),
    createdAt: Number(row.created_at),
    // The full map includes README text and every detected route; the client
    // only needs the summary bits, so trim rather than ship tens of KB.
    summary: repoMap
      ? {
          languages: repoMap.languages,
          entryPoints: repoMap.entryPoints,
          endpointCount: repoMap.endpoints.length,
          endpoints: repoMap.endpoints.slice(0, 40),
          dependencies: repoMap.dependencies.map((d) => ({
            manifest: d.manifest,
            count: d.runtime.length + d.dev.length,
            runtime: d.runtime.slice(0, 24),
          })),
        }
      : null,
  });
}

/**
 * Idempotent by design: deleting an id that is already gone reports success
 * rather than 404. The client removes the row optimistically and a poll can
 * refresh underneath it, so "not found" here means the user's intent was
 * already satisfied — surfacing it as an error would just be a spurious red
 * banner on a row that is correctly gone.
 */
export async function DELETE(_request: Request, context: Context) {
  const { id } = await context.params;

  try {
    const deleted = await deleteRepository(id);
    return NextResponse.json({ ok: true, deleted });
  } catch (error) {
    logger.error("failed to delete repository", error, { repoId: id });
    return NextResponse.json({ error: "Could not delete this repository." }, { status: 500 });
  }
}
