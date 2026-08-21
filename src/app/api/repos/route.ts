import { NextResponse, after } from "next/server";
import { z } from "zod";

import { checkRateLimit, clientKey } from "@/lib/guardrails/rate-limit";
import { startIngestion } from "@/lib/ingest/pipeline";
import { IngestError, parseGitHubUrl } from "@/lib/ingest/sources";
import { logger } from "@/lib/observability/logger";
import { listRepositories } from "@/lib/repos";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Indexing continues after this route responds, so the function has to stay
 * alive well past the 202 — see the `after()` call in POST.
 *
 * 60s is the ceiling on Vercel's Hobby plan. Raise it to 300 on Pro if you
 * index large repositories; the honest constraint is documented in the README,
 * along with why a job queue is the real fix.
 */
export const maxDuration = 60;

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
  return NextResponse.json({ repositories: await listRepositories() });
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
    }

    const started =
      parsed.data.sourceType === "github"
        ? await startIngestion({ sourceType: "github", sourceRef: parsed.data.url })
        : await startIngestion({
            sourceType: "upload",
            sourceRef: parsed.data.name,
            files: parsed.data.files,
          });

    // Keep the serverless function alive until indexing finishes.
    //
    // Without this the platform is free to freeze or reclaim the instance the
    // moment the 202 is written, killing indexing part-way and leaving a row
    // stuck in `indexing` forever. `after()` runs the callback once the
    // response is sent but keeps the invocation billed and alive, bounded by
    // `maxDuration` above.
    //
    // Self-hosted (Docker, a VM) this is a no-op — the process was never going
    // to be frozen. It costs nothing there and is essential on Vercel.
    after(() => started.done);

    return NextResponse.json({ id: started.id }, { status: 202 });
  } catch (error) {
    if (error instanceof IngestError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    logger.error("failed to start ingestion", error);
    return NextResponse.json({ error: "Could not start indexing." }, { status: 500 });
  }
}
