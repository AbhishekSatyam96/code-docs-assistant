import { describe, expect, it } from "vitest";

import { verifiedSslMode } from "@/lib/db";

const NEON = "postgresql://user:pw@ep-x-pooler.region.aws.neon.tech/neondb";

/**
 * These assert the *property* that matters — no connection string ever reaches
 * `pg` asking for an SSL mode that pg 9 will read as "encrypt but verify
 * nothing" — rather than the exact rewritten string, so that the modes a URL is
 * allowed to arrive in can grow without rewriting the expectations.
 */
describe("verifiedSslMode", () => {
  it.each(["require", "prefer", "verify-ca"])("upgrades sslmode=%s", (mode) => {
    const url = new URL(verifiedSslMode(`${NEON}?sslmode=${mode}`));
    expect(url.searchParams.get("sslmode")).toBe("verify-full");
  });

  it("preserves the rest of the URL", () => {
    const url = new URL(verifiedSslMode(`${NEON}?sslmode=require&channel_binding=require`));

    expect(url.searchParams.get("channel_binding")).toBe("require");
    expect(url.username).toBe("user");
    expect(url.password).toBe("pw");
    expect(url.host).toBe("ep-x-pooler.region.aws.neon.tech");
    expect(url.pathname).toBe("/neondb");
  });

  // `disable` and `no-verify` are deliberate opt-outs, not the ambiguous modes
  // the deprecation is about. Upgrading them would break local development
  // against a Postgres with no TLS at all.
  it.each(["verify-full", "disable", "no-verify"])("leaves sslmode=%s alone", (mode) => {
    const url = `${NEON}?sslmode=${mode}`;
    expect(verifiedSslMode(url)).toBe(url);
  });

  it("leaves a URL with no sslmode alone", () => {
    // Untouched rather than upgraded: the pool's own `ssl` option decides this
    // case, and a local database usually has no TLS to verify.
    const local = "postgresql://postgres:postgres@localhost:5432/codedocs";
    expect(verifiedSslMode(local)).toBe(local);
  });

  it("passes an unparseable string through for the pool to reject", () => {
    expect(verifiedSslMode("not a url")).toBe("not a url");
  });
});
