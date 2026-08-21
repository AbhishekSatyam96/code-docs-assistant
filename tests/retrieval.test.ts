import { describe, expect, it } from "vitest";

import { buildFtsQuery } from "@/lib/retrieval/fts-query";
import { reciprocalRankFusion } from "@/lib/retrieval/fusion";

describe("reciprocalRankFusion", () => {
  it("ranks a document found by both retrievers above one found by either alone", () => {
    const vector = [10, 20, 30];
    const keyword = [40, 20, 50];

    const fused = reciprocalRankFusion([vector, keyword], 60);

    // 20 is rank 2 in both lists; 10 and 40 are rank 1 in one list each.
    expect(fused[0].id).toBe(20);
    expect(fused.find((f) => f.id === 20)!.ranks).toEqual([2, 2]);
  });

  it("scores by rank position, ignoring the underlying score magnitudes", () => {
    const fused = reciprocalRankFusion([[1, 2]], 60);
    expect(fused[0].score).toBeCloseTo(1 / 61, 10);
    expect(fused[1].score).toBeCloseTo(1 / 62, 10);
  });

  it("keeps documents that appear in only one list", () => {
    const fused = reciprocalRankFusion([[1], [2]], 60);
    expect(fused.map((f) => f.id).sort()).toEqual([1, 2]);
  });

  it("breaks ties deterministically so results are stable across runs", () => {
    const a = reciprocalRankFusion([[3, 1, 2]], 60);
    const b = reciprocalRankFusion([[3, 1, 2]], 60);
    expect(a.map((f) => f.id)).toEqual(b.map((f) => f.id));
  });

  it("handles empty input", () => {
    expect(reciprocalRankFusion([])).toEqual([]);
    expect(reciprocalRankFusion([[], []])).toEqual([]);
  });

  it("gives a lower k a sharper preference for the top rank", () => {
    const sharp = reciprocalRankFusion([[1], [2]], 1);
    const flat = reciprocalRankFusion([[1], [2]], 1000);
    expect(sharp[0].score).toBeGreaterThan(flat[0].score);
  });
});

describe("buildFtsQuery", () => {
  it("drops question stopwords that would match everything", () => {
    const query = buildFtsQuery("how does the app handle errors")!;
    expect(query).not.toContain('"how"');
    expect(query).not.toContain('"the"');
    expect(query).toContain('"errors"');
    expect(query).toContain('"handle"');
  });

  it("keeps the identifier and adds its component words", () => {
    const query = buildFtsQuery("where is parseJwtPayload called")!;
    expect(query).toContain('"parsejwtpayload"');
    expect(query).toContain('"parse"');
    expect(query).toContain('"jwt"');
    expect(query).toContain('"payload"');
  });

  it("splits snake_case and dotted paths", () => {
    const query = buildFtsQuery("what does get_user_by_id do")!;
    expect(query).toContain('"get_user_by_id"');
    expect(query).toContain('"user"');
  });

  it("quotes every term so FTS5 operators cannot be injected", () => {
    // `OR`, `NEAR` and `*` are FTS5 syntax; none may survive unquoted.
    const query = buildFtsQuery('session OR NEAR("secret") AND *')!;
    for (const term of query.split(" OR ")) {
      expect(term).toMatch(/^"[^"]*"$/);
    }
  });

  it("escapes embedded double quotes rather than breaking the expression", () => {
    const query = buildFtsQuery('find the "config" loader');
    expect(query).not.toBeNull();
    // Balanced quotes overall — no dangling quote that would be a syntax error.
    expect((query!.match(/"/g) ?? []).length % 2).toBe(0);
  });

  it("returns null when nothing usable survives, so callers can fall back", () => {
    expect(buildFtsQuery("how does it work")).toBeNull();
    expect(buildFtsQuery("???")).toBeNull();
    expect(buildFtsQuery("")).toBeNull();
  });

  it("caps term count to keep the MATCH expression bounded", () => {
    const long = Array.from({ length: 100 }, (_, i) => `identifier${i}`).join(" ");
    const query = buildFtsQuery(long)!;
    expect(query.split(" OR ").length).toBeLessThanOrEqual(24);
  });
});
