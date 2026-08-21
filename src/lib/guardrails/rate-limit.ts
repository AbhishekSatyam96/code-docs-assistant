import { LIMITS } from "@/lib/config";

interface Bucket {
  tokens: number;
  updatedAt: number;
}

const buckets = new Map<string, Bucket>();

/**
 * In-process token bucket, keyed by client IP.
 *
 * Deliberately the simplest thing that works for a single-instance deployment:
 * it protects the OpenAI spend and stops one tab hammering the box. It is
 * explicitly *not* production-grade — the state is per-process, so it does not
 * survive a restart and does not coordinate across replicas. The README lists
 * the Redis/managed-gateway replacement as part of productionising.
 */
export function checkRateLimit(key: string): { allowed: boolean; retryAfterMs: number } {
  const now = Date.now();
  const capacity = LIMITS.requestsPerMinute;
  const refillPerMs = capacity / 60_000;

  const bucket = buckets.get(key) ?? { tokens: capacity, updatedAt: now };
  bucket.tokens = Math.min(capacity, bucket.tokens + (now - bucket.updatedAt) * refillPerMs);
  bucket.updatedAt = now;

  if (bucket.tokens < 1) {
    buckets.set(key, bucket);
    return { allowed: false, retryAfterMs: Math.ceil((1 - bucket.tokens) / refillPerMs) };
  }

  bucket.tokens -= 1;
  buckets.set(key, bucket);

  // Opportunistic cleanup so an attacker cycling IPs cannot grow the map
  // without bound.
  if (buckets.size > 10_000) {
    for (const [k, b] of buckets) {
      if (now - b.updatedAt > 120_000) buckets.delete(k);
    }
  }

  return { allowed: true, retryAfterMs: 0 };
}

export function clientKey(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return request.headers.get("x-real-ip") ?? "local";
}
