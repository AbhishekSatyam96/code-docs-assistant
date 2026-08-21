import { NextResponse } from "next/server";

import { query, tbl } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * Serve a file's contents so a citation can be opened in context.
 *
 * Reading from the indexed copy in Postgres rather than the filesystem is
 * deliberate: it guarantees the user sees exactly the revision the answer was
 * based on, and there is no path for a crafted `path` parameter to escape into
 * the host filesystem — the parameter is only ever a database lookup key.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const repoId = url.searchParams.get("repoId");
  const path = url.searchParams.get("path");

  if (!repoId || !path) {
    return NextResponse.json({ error: "repoId and path are required." }, { status: 400 });
  }

  const [row] = await query<{
    path: string;
    language: string;
    content: string;
    loc: number;
  }>(
    `SELECT path, language, content, loc FROM ${tbl("files")} WHERE repo_id = $1 AND path = $2`,
    [repoId, path],
  );

  if (!row) {
    return NextResponse.json({ error: "File not found in this index." }, { status: 404 });
  }

  return NextResponse.json({
    path: row.path,
    language: row.language,
    loc: Number(row.loc),
    content: row.content,
  });
}
