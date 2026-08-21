import { RAG } from "@/lib/config";
import { tokenCount } from "@/lib/tokens";
import { detectLanguage, type ChunkKind } from "./languages";

export interface CodeChunk {
  ordinal: number;
  /** 1-based, inclusive. */
  startLine: number;
  /** 1-based, inclusive. */
  endLine: number;
  symbol: string | null;
  kind: ChunkKind;
  tokenCount: number;
  /** Verbatim source slice — what the user sees in a citation. */
  content: string;
  /** What actually gets embedded and keyword-indexed. */
  embedText: string;
}

export interface ChunkOptions {
  maxTokens?: number;
  minTokens?: number;
  overlapLines?: number;
}

/**
 * Structure-aware chunking.
 *
 * ## Why not fixed-size windows?
 * A 700-token sliding window cuts functions in half roughly half the time. The
 * retrieved fragment then contains a signature with no body, or a body with no
 * signature, and the model has to guess. For a tool whose entire job is
 * explaining code, that failure mode is fatal.
 *
 * ## Why not a real parser (tree-sitter)?
 * It is the correct answer for a production system and I would reach for it
 * with more time. It costs a WASM runtime plus a grammar per language, and
 * every unsupported language silently falls back to nothing. The regex
 * boundary detection here gets most of the benefit — chunks that begin at a
 * declaration — across ~30 languages in a few dozen lines, and degrades to
 * plain line packing rather than breaking. That trade is documented in the
 * README as the first thing I'd replace.
 *
 * ## The algorithm
 * 1. Find lines that begin a semantic unit (function/class/heading).
 * 2. Treat the span between consecutive boundaries as an atomic unit.
 * 3. Greedily pack whole units into chunks up to the token budget.
 * 4. Hard-split, with line overlap, only the units too large to fit alone.
 *
 * The result is that a chunk boundary almost always coincides with a
 * declaration boundary, and small helper functions get grouped with their
 * neighbours instead of each becoming a lonely 20-token chunk.
 */
export function chunkFile(
  filePath: string,
  content: string,
  options: ChunkOptions = {},
): CodeChunk[] {
  const maxTokens = options.maxTokens ?? RAG.maxChunkTokens;
  const minTokens = options.minTokens ?? RAG.minChunkTokens;
  const overlapLines = options.overlapLines ?? RAG.overlapLines;

  const spec = detectLanguage(filePath);
  if (!spec) return [];
  if (content.trim().length === 0) return [];

  const lines = content.split("\n");
  const units = splitIntoUnits(lines, spec.unitStart);
  const packed = packUnits(units, lines, maxTokens, minTokens, overlapLines);

  return packed.map((range, index) => {
    const slice = lines.slice(range.start, range.end + 1).join("\n");
    const symbol = range.symbol;
    const embedText = buildEmbedText({
      filePath,
      language: spec.language,
      symbol,
      startLine: range.start + 1,
      endLine: range.end + 1,
      content: slice,
    });

    return {
      ordinal: index,
      startLine: range.start + 1,
      endLine: range.end + 1,
      symbol,
      kind: spec.kind,
      tokenCount: tokenCount(embedText),
      content: slice,
      embedText,
    };
  });
}

interface Unit {
  start: number;
  end: number;
  symbol: string | null;
}

/** Split the file into spans that each begin at a declaration boundary. */
function splitIntoUnits(lines: string[], unitStart?: RegExp): Unit[] {
  if (!unitStart) {
    return [{ start: 0, end: lines.length - 1, symbol: null }];
  }

  const boundaries: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (unitStart.test(lines[i])) boundaries.push(i);
  }

  if (boundaries.length === 0) {
    return [{ start: 0, end: lines.length - 1, symbol: null }];
  }

  const units: Unit[] = [];

  // Everything before the first declaration (imports, license header, module
  // docstring) is its own unit. It carries real signal about dependencies.
  if (boundaries[0] > 0) {
    units.push({ start: 0, end: boundaries[0] - 1, symbol: null });
  }

  for (let b = 0; b < boundaries.length; b++) {
    const start = boundaries[b];
    const end = b + 1 < boundaries.length ? boundaries[b + 1] - 1 : lines.length - 1;
    units.push({ start, end, symbol: extractSymbol(lines[start]) });
  }

  return units;
}

interface PackedRange {
  start: number;
  end: number;
  symbol: string | null;
}

function packUnits(
  units: Unit[],
  lines: string[],
  maxTokens: number,
  minTokens: number,
  overlapLines: number,
): PackedRange[] {
  const ranges: PackedRange[] = [];
  let current: PackedRange | null = null;
  let currentTokens = 0;

  const flush = () => {
    if (current) ranges.push(current);
    current = null;
    currentTokens = 0;
  };

  for (const unit of units) {
    const text = lines.slice(unit.start, unit.end + 1).join("\n");
    const tokens = tokenCount(text);

    // A single unit bigger than the budget (a god-class, a giant switch) is
    // split by lines with overlap so no boundary loses its surrounding context.
    if (tokens > maxTokens) {
      flush();
      ranges.push(...hardSplit(unit, lines, maxTokens, overlapLines));
      continue;
    }

    if (current && currentTokens + tokens > maxTokens) flush();

    if (!current) {
      current = { start: unit.start, end: unit.end, symbol: unit.symbol };
      currentTokens = tokens;
    } else {
      current.end = unit.end;
      current.symbol ??= unit.symbol;
      currentTokens += tokens;
    }
  }
  flush();

  return mergeUndersizedTail(ranges, lines, minTokens, maxTokens);
}

function hardSplit(
  unit: Unit,
  lines: string[],
  maxTokens: number,
  overlapLines: number,
): PackedRange[] {
  const out: PackedRange[] = [];
  let start = unit.start;

  while (start <= unit.end) {
    let end = start;
    let tokens = 0;

    while (end <= unit.end) {
      const lineTokens = tokenCount(lines[end]) + 1; // +1 for the newline
      if (tokens + lineTokens > maxTokens && end > start) break;
      tokens += lineTokens;
      end++;
    }
    end = Math.min(end - 1, unit.end);

    out.push({ start, end, symbol: unit.symbol });
    if (end >= unit.end) break;

    // Cap overlap at half the window. Without this, a unit made of very long
    // lines yields windows narrower than `overlapLines`, the stride collapses
    // to one line, and the index fills with near-duplicate chunks that crowd
    // out genuinely distinct code at retrieval time.
    const span = end - start + 1;
    const overlap = Math.min(overlapLines, Math.floor(span / 2));
    start = Math.max(end - overlap + 1, start + 1);
  }

  return out;
}

/**
 * A trailing 15-token chunk (a closing brace and an export line) is pure noise
 * in the index: it will occasionally win a keyword match and waste a slot.
 * Fold it back into its predecessor when that stays within budget.
 */
function mergeUndersizedTail(
  ranges: PackedRange[],
  lines: string[],
  minTokens: number,
  maxTokens: number,
): PackedRange[] {
  const out: PackedRange[] = [];

  for (const range of ranges) {
    const text = lines.slice(range.start, range.end + 1).join("\n");
    const tokens = tokenCount(text);
    const previous = out[out.length - 1];

    if (previous && tokens < minTokens) {
      const mergedTokens = tokenCount(
        lines.slice(previous.start, range.end + 1).join("\n"),
      );
      if (mergedTokens <= maxTokens) {
        previous.end = range.end;
        continue;
      }
    }
    out.push({ ...range });
  }

  return out.filter((r) => lines.slice(r.start, r.end + 1).join("").trim().length > 0);
}

/** Best-effort declaration name from a boundary line. */
export function extractSymbol(line: string): string | null {
  const patterns: RegExp[] = [
    /(?:function|class|interface|type|enum|struct|trait|impl|namespace|module|record|def|fn|func)\s+([A-Za-z_$][\w$]*)/,
    /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[:=]/,
    /^\s*(?:public|private|protected|static|final|async|override)[\w\s]*?\s([A-Za-z_$][\w$]*)\s*\(/,
    /^#{1,6}\s+(.{1,80}?)\s*$/, // markdown heading
    /^\s*([A-Za-z_$][\w$]*)\s*\(\s*\)\s*\{/, // shell function
  ];

  for (const pattern of patterns) {
    const match = line.match(pattern);
    if (match?.[1]) return match[1].trim();
  }
  return null;
}

/**
 * Contextual embedding text.
 *
 * The retrieved unit of code is prefixed with where it lives. Two payoffs:
 *  - a chunk from `src/api/auth/login.ts` matches a query about "login API"
 *    even when the word "login" never appears in the body;
 *  - the model sees the path inline, so it can cite accurately instead of
 *    inferring a filename from the code.
 *
 * The header is included in the embedded text *and* the FTS index, so both
 * retrievers benefit.
 */
function buildEmbedText(input: {
  filePath: string;
  language: string;
  symbol: string | null;
  startLine: number;
  endLine: number;
  content: string;
}): string {
  const header = [
    `File: ${input.filePath}`,
    `Language: ${input.language}`,
    input.symbol ? `Symbol: ${input.symbol}` : null,
    `Lines: ${input.startLine}-${input.endLine}`,
  ]
    .filter(Boolean)
    .join("\n");

  return `${header}\n\n${input.content}`;
}
