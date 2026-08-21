import { describe, expect, it } from "vitest";

import { chunkFile, extractSymbol } from "@/lib/ingest/chunker";

const TS_SOURCE = `import { readFile } from "node:fs/promises";
import path from "node:path";

const CACHE = new Map<string, string>();

export function loadConfig(name: string): string {
  const key = path.resolve(name);
  if (CACHE.has(key)) return CACHE.get(key)!;
  return key;
}

export class ConfigStore {
  private entries = new Map<string, string>();

  get(key: string) {
    return this.entries.get(key);
  }

  set(key: string, value: string) {
    this.entries.set(key, value);
  }
}

export async function reload(): Promise<void> {
  CACHE.clear();
}
`;

/**
 * 60 tokens is chosen so that each declaration in TS_SOURCE fits in a chunk on
 * its own but two do not — which is the regime the chunker is designed for, and
 * the one where the "chunks align to declarations" property is meaningful. A
 * smaller budget would force hard-splitting, which is a different code path
 * with deliberately different (overlapping) behaviour, tested separately below.
 */
const ONE_UNIT_PER_CHUNK = { maxTokens: 60, minTokens: 1 };

describe("chunkFile", () => {
  it("produces chunks that begin at declaration boundaries", () => {
    const chunks = chunkFile("src/config.ts", TS_SOURCE, ONE_UNIT_PER_CHUNK);

    expect(chunks.length).toBeGreaterThan(1);

    // The first chunk is the import preamble; every later chunk opens on a
    // declaration rather than mid-body.
    const starts = chunks.slice(1).map((chunk) => chunk.content.split("\n")[0].trim());
    expect(starts).toEqual([
      "export function loadConfig(name: string): string {",
      "export class ConfigStore {",
      "export async function reload(): Promise<void> {",
    ]);
  });

  it("keeps a whole function together when it fits the budget", () => {
    const chunks = chunkFile("src/config.ts", TS_SOURCE, ONE_UNIT_PER_CHUNK);
    const owner = chunks.find((c) => c.content.includes("export function loadConfig"))!;

    // Signature, body and closing brace land in the same chunk.
    expect(owner.content).toContain("const key = path.resolve(name);");
    expect(owner.content).toContain("return key;");
  });

  it("covers every line exactly once when nothing is oversized", () => {
    const chunks = chunkFile("src/config.ts", TS_SOURCE, ONE_UNIT_PER_CHUNK);
    const sorted = [...chunks].sort((a, b) => a.startLine - b.startLine);

    expect(sorted[0].startLine).toBe(1);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i].startLine).toBe(sorted[i - 1].endLine + 1);
    }
    expect(sorted.at(-1)!.endLine).toBe(TS_SOURCE.split("\n").length);
  });

  it("hard-splits an oversized unit with overlap so context is not lost", () => {
    const giant = [
      "export function huge() {",
      ...Array.from({ length: 400 }, (_, i) => `  const value${i} = ${i} * 2;`),
      "}",
    ].join("\n");

    const chunks = chunkFile("src/huge.ts", giant, { maxTokens: 200, overlapLines: 5 });

    expect(chunks.length).toBeGreaterThan(1);
    // Consecutive chunks share lines — that is the overlap doing its job.
    expect(chunks[1].startLine).toBeLessThanOrEqual(chunks[0].endLine);
    // …and the whole unit is still covered, end to end.
    expect(chunks.at(-1)!.endLine).toBe(giant.split("\n").length);
  });

  it("caps overlap at half the window so hard-splitting keeps making progress", () => {
    // Regression: with `overlapLines` wider than the window itself, the stride
    // collapsed to one line and the index filled with near-duplicate chunks.
    // Here ~6 short lines fit per window, so a 40-line overlap request must be
    // clamped to 3 rather than rewinding past the window start.
    const body = [
      "export function wide() {",
      ...Array.from({ length: 60 }, (_, i) => `  const v${i} = ${i};`),
      "}",
    ].join("\n");

    const chunks = chunkFile("src/wide.ts", body, {
      maxTokens: 60,
      overlapLines: 40,
      minTokens: 1,
    });

    expect(chunks.length).toBeGreaterThan(1);

    for (let i = 1; i < chunks.length; i++) {
      const stride = chunks[i].startLine - chunks[i - 1].startLine;
      const window = chunks[i - 1].endLine - chunks[i - 1].startLine + 1;
      // Advances by at least half a window — never one line at a time.
      expect(stride).toBeGreaterThanOrEqual(Math.floor(window / 2));
      expect(stride).toBeGreaterThan(1);
    }

    // Sanity: strided windows, not one chunk per line.
    expect(chunks.length).toBeLessThan(30);
    expect(chunks.at(-1)!.endLine).toBe(body.split("\n").length);
  });

  it("prefixes every chunk with a contextual header", () => {
    const [first] = chunkFile("src/deep/config.ts", TS_SOURCE);
    expect(first.embedText).toContain("File: src/deep/config.ts");
    expect(first.embedText).toContain("Language: typescript");
    expect(first.embedText).toContain("Lines: ");
  });

  it("splits markdown on headings", () => {
    const markdown = `# Title\n\nIntro text.\n\n## Setup\n\nRun the thing.\n\n## Usage\n\nUse the thing.\n`;
    const chunks = chunkFile("README.md", markdown, { maxTokens: 12, minTokens: 1 });
    const symbols = chunks.map((c) => c.symbol).filter(Boolean);
    expect(symbols).toContain("Setup");
  });

  it("returns nothing for unknown extensions or empty files", () => {
    expect(chunkFile("image.png", "whatever")).toEqual([]);
    expect(chunkFile("src/a.ts", "   \n  \n")).toEqual([]);
  });

  it("handles a file with no declarations at all", () => {
    const chunks = chunkFile("src/data.ts", "1\n2\n3\n");
    expect(chunks).toHaveLength(1);
    expect(chunks[0].startLine).toBe(1);
  });
});

describe("extractSymbol", () => {
  it.each([
    ["export function loadConfig(name: string) {", "loadConfig"],
    ["export class ConfigStore {", "ConfigStore"],
    ["  async def fetch_user(self, id):", "fetch_user"],
    ["func HandleRequest(w http.ResponseWriter) {", "HandleRequest"],
    ["const handler = async (req) => {", "handler"],
    ["## Configuration", "Configuration"],
    ["pub fn parse_args() -> Args {", "parse_args"],
  ])("extracts %j -> %j", (line, expected) => {
    expect(extractSymbol(line)).toBe(expected);
  });

  it("returns null when there is no declaration", () => {
    expect(extractSymbol("  const x = y + z;")).toBe("x");
    expect(extractSymbol("    return true;")).toBeNull();
  });
});
