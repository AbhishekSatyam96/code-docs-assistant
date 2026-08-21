import { NextResponse } from "next/server";
import { z } from "zod";

import { checkRateLimit, clientKey } from "@/lib/guardrails/rate-limit";
import { startIngestion } from "@/lib/ingest/pipeline";
import { IngestError, parseGitHubUrl } from "@/lib/ingest/sources";
import { logger } from "@/lib/observability/logger";
import { listRepositories } from "@/lib/repos";

export const dynamic = "force-dynamic";

const GitHubBody = z.object({
  sourceType: z.literal("github"),
  url: z.string().min(1).max(500),
});

const UploadBody = z.object({
  sourceType: z.literal("upload"),
  name: z.string().min(1).max(120),
  files: z
    .array(
      z.object({
        path: z.string().min(1).max(400),
        content: z.string(),
      }),
    )
    .min(1)
    .max(3_000),
});

const Body = z.discriminatedUnion("sourceType", [GitHubBody, UploadBody]);

export async function GET() {
  return NextResponse.json({ repositories: listRepositories() });
}

export async function POST(request: Request) {
  const limit = checkRateLimit(clientKey(request));
  if (!limit.allowed) {
    return NextResponse.json(
      { error: "Too many requests. Please wait a moment." },
      { status: 429, headers: { "Retry-After": String(Math.ceil(limit.retryAfterMs / 1000)) } },
    );
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const parsed = Body.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid request." },
      { status: 400 },
    );
  }

  try {
    if (parsed.data.sourceType === "github") {
      // Validate the URL synchronously so a typo returns 400 immediately
      // instead of surfacing as a failed background job seconds later.
      parseGitHubUrl(parsed.data.url);
      const { id } = startIngestion({ sourceType: "github", sourceRef: parsed.data.url });
      return NextResponse.json({ id }, { status: 202 });
    }

    const { id } = startIngestion({
      sourceType: "upload",
      sourceRef: parsed.data.name,
      files: parsed.data.files,
    });
    return NextResponse.json({ id }, { status: 202 });
  } catch (error) {
    if (error instanceof IngestError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    logger.error("failed to start ingestion", error);
    return NextResponse.json({ error: "Could not start indexing." }, { status: 500 });
  }
}
