import { NextResponse } from "next/server";
import { z } from "zod";

import { LIMITS } from "@/lib/config";
import { checkRateLimit, clientKey } from "@/lib/guardrails/rate-limit";
import { ask, type AnswerEvent } from "@/lib/llm/answer";
import { logger } from "@/lib/observability/logger";

export const dynamic = "force-dynamic";
// The Node runtime, not Edge: `pg` opens a TCP socket to Postgres, which the
// Edge runtime cannot do.
export const runtime = "nodejs";

const Body = z.object({
  repoId: z.string().min(1).max(40),
  question: z.string().trim().min(1).max(LIMITS.maxQuestionChars),
  history: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().max(8_000),
      }),
    )
    .max(40)
    .default([]),
});

/**
 * Newline-delimited JSON rather than Server-Sent Events.
 *
 * SSE would be the reflexive choice, but this endpoint streams four different
 * event shapes (status, sources, delta, done) and SSE's `event:`/`data:` framing
 * means re-encoding structured payloads as strings on both ends. NDJSON is one
 * `JSON.parse` per line, needs no client library, and — unlike `EventSource` —
 * works over POST, which matters because the question and history belong in a
 * body, not a query string.
 */
export async function POST(request: Request) {
  const limit = checkRateLimit(clientKey(request));
  if (!limit.allowed) {
    return NextResponse.json(
      { error: "You're asking faster than I can answer. Give it a few seconds." },
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

  const encoder = new TextEncoder();
  const send = (event: AnswerEvent) => encoder.encode(JSON.stringify(event) + "\n");

  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const event of ask(parsed.data)) {
          controller.enqueue(send(event));
        }
      } catch (error) {
        // The client has already received a 200 and partial output by now, so
        // the failure has to be reported in-band rather than as a status code.
        logger.error("chat stream failed", error);
        controller.enqueue(
          send({ type: "error", message: "Something went wrong while answering." }),
        );
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      // Tells nginx and friends not to buffer the response into oblivion.
      "X-Accel-Buffering": "no",
    },
  });
}
