import { describe, expect, it } from "vitest";

import { buildTsQuery, extractSearchTerms } from "@/lib/retrieval/fts-query";
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

describe("extractSearchTerms", () => {
  it("drops question stopwords that would match everything", () => {
    const terms = extractSearchTerms("how does the app handle errors");
    expect(terms).not.toContain("how");
    expect(terms).not.toContain("the");
    expect(terms).toEqual(expect.arrayContaining(["errors", "handle"]));
  });

  it("keeps the identifier and adds its component words", () => {
    const terms = extractSearchTerms("where is parseJwtPayload called");
    expect(terms).toEqual(
      expect.arrayContaining(["parsejwtpayload", "parse", "jwt", "payload"]),
    );
  });

  /**
   * Regression, found in a production trace. The identifier test used to be
   * "contains an uppercase letter", so a sentence-initial capital counted —
   * and "How does the view engine render?" searched for `how`, exempting the
   * most common word in English from the stopword list.
   */
  it("does not treat a sentence-initial capital as an identifier", () => {
    for (const question of [
      "How does the view engine render templates?",
      "What is the router doing?",
      "Where are errors handled?",
      "The app handles requests",
    ]) {
      const terms = extractSearchTerms(question);
      for (const stopword of ["how", "what", "where", "the"]) {
        expect(terms, question).not.toContain(stopword);
      }
    }
  });

  it("still recognises the identifier shapes that matter", () => {
    // Interior case change, snake_case, dotted, and SCREAMING_CASE.
    expect(extractSearchTerms("ConfigStore")).toContain("config");
    expect(extractSearchTerms("get_user_by_id")).toContain("user");
    expect(extractSearchTerms("res.status")).toContain("status");
    expect(extractSearchTerms("HTTP handling")).toContain("http");
  });

  it("keeps a PascalCase word even though it is not flagged as an identifier", () => {
    // `View` has no interior case change, so the heuristic says "not an
    // identifier" — which costs nothing, because it is not a stopword either.
    expect(extractSearchTerms("how does View work")).toContain("view");
  });

  it("splits snake_case and dotted paths", () => {
    expect(extractSearchTerms("what does get_user_by_id do")).toEqual(
      expect.arrayContaining(["get_user_by_id", "user"]),
    );
    expect(extractSearchTerms("check res.status handling")).toEqual(
      expect.arrayContaining(["res.status", "res", "status"]),
    );
  });

  it("caps term count so the tsquery stays bounded", () => {
    const long = Array.from({ length: 100 }, (_, i) => `identifier${i}`).join(" ");
    expect(extractSearchTerms(long).length).toBeLessThanOrEqual(24);
  });
});

describe("buildTsQuery", () => {
  it("OR-joins the surviving terms", () => {
    const query = buildTsQuery("where is validateSession implemented")!;
    expect(query.split(" | ")).toEqual(expect.arrayContaining(["validatesession"]));
    expect(query).toContain(" | ");
  });

  /**
   * `to_tsquery` parses a query language — `&`, `|`, `!`, `<->`, parens and
   * `:*` are all operators. Rather than escaping, every term is reduced to
   * [a-z0-9_], which makes an operator unrepresentable by construction. These
   * cases assert that property directly rather than checking for specific
   * escapes, so the test still holds if the sanitiser is reimplemented.
   */
  it("cannot emit a tsquery operator, whatever the input", () => {
    for (const attack of [
      'session | NEAR("secret")',
      "auth & !private",
      "token:* <-> secret",
      "(a | b) & c",
      "'; DROP TABLE chunks; --",
      "term'''quote",
    ]) {
      const query = buildTsQuery(attack);
      if (query === null) continue;
      for (const term of query.split(" | ")) {
        expect(term).toMatch(/^[a-z0-9_]+$/);
      }
    }
  });

  it("returns null when nothing usable survives, so callers can fall back", () => {
    expect(buildTsQuery("how does it work")).toBeNull();
    expect(buildTsQuery("???")).toBeNull();
    expect(buildTsQuery("")).toBeNull();
  });

  it("de-duplicates terms", () => {
    const query = buildTsQuery("session session SESSION")!;
    expect(query.split(" | ")).toEqual(["session"]);
  });
});
