import { countTokens } from "gpt-tokenizer";

/**
 * Exact token counts via a pure-JS BPE tokenizer.
 *
 * Character-count heuristics (`length / 4`) are off by 30-40% on code, because
 * identifiers, punctuation runs and indentation tokenise very differently to
 * prose. Since chunk sizing and the context budget are both expressed in
 * tokens, guessing here would quietly under- or over-fill every prompt.
 */
export function tokenCount(text: string): number {
  try {
    return countTokens(text);
  } catch {
    // The tokenizer can reject lone surrogates from mangled source files.
    // Degrading to an estimate is better than failing a whole ingestion.
    return Math.ceil(text.length / 4);
  }
}
