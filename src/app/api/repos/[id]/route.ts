import { NextResponse } from "next/server";

import { getDb } from "@/lib/db";
import { deleteRepository } from "@/lib/ingest/pipeline";
import type { RepoMap } from "@/lib/ingest/repo-map";

export const dynamic = "force-dynamic";

interface Context {
  params: Promise<{ id: string }>;
}

export async function GET(_request: Request, context: Context) {
  const { id } = await context.params;

  const row = getDb()
    .prepare(
      `SELECT id, name, source_type, source_ref, commit_ref, status, status_detail,
              progress, file_count, chunk_count, embed_tokens, repo_map, created_at
       FROM repositories WHERE id = ?`,
    )
    .get(id) as Record<string, unknown> | undefined;

  if (!row) {
    return NextResponse.json({ error: "Repository not found." }, { status: 404 });
  }

  const repoMap: RepoMap | null = row.repo_map
    ? JSON.parse(row.repo_map as string)
    : null;

  return NextResponse.json({
    id: row.id,
    name: row.name,
    sourceType: row.source_type,
    sourceRef: row.source_ref,
    commitRef: row.commit_ref,
    status: row.status,
    statusDetail: row.status_detail,
    progress: row.progress,
    fileCount: row.file_count,
    chunkCount: row.chunk_count,
    embedTokens: row.embed_tokens,
    createdAt: row.created_at,
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

export async function DELETE(_request: Request, context: Context) {
  const { id } = await context.params;
  deleteRepository(id);
  return NextResponse.json({ ok: true });
}
