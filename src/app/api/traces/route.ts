import { NextResponse } from "next/server";

import { listTraces, traceStats } from "@/lib/observability/traces";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const limit = Math.min(
    Number(new URL(request.url).searchParams.get("limit") ?? 30) || 30,
    100,
  );

  const [stats, traces] = await Promise.all([traceStats(), listTraces(limit)]);
  return NextResponse.json({ stats, traces });
}
