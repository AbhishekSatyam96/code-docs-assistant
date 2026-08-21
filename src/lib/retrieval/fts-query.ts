/**
 * English stopwords plus the question vocabulary developers actually use.
 *
 * Without this, "how does the app handle errors" matches essentially every
 * chunk on "the"/"does"/"how" and BM25 degenerates into noise that pollutes
 * the fused ranking.
 */
const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "if", "then", "than", "of", "in", "on",
  "at", "to", "for", "with", "by", "from", "as", "is", "are", "was", "were",
  "be", "been", "being", "do", "does", "did", "doing", "have", "has", "had",
  "how", "what", "where", "when", "why", "who", "which", "this", "that",
  "these", "those", "it", "its", "i", "you", "we", "they", "me", "my", "our",
  "can", "could", "should", "would", "will", "shall", "may", "might", "must",
  "there", "here", "about", "into", "over", "after", "before", "between",
  "explain", "describe", "tell", "show", "give", "list", "find", "work",
  "works", "working", "used", "use", "uses", "using", "code", "codebase",
  "repo", "repository", "project", "please", "me", "does", "do",
]);

/**
 * Turn a natural-language question into a valid FTS5 MATCH expression.
 *
 * Two things matter here:
 *
 *  1. **Safety.** FTS5 MATCH is a query language, not a string. Passing raw
 *     user input means `"` or `NEAR` or an unbalanced paren throws a SQL
 *     error, and the syntax is expressive enough that it deserves the same
 *     suspicion as SQL itself. Every term is extracted with a conservative
 *     character class and re-quoted, so nothing the user types is ever
 *     interpreted as operators.
 *
 *  2. **camelCase splitting.** A user asking about "the auth middleware" should
 *     match `authMiddleware`, and someone pasting `getUserById` should match
 *     prose about "get user by id". Indexing keeps the original token (the
 *     tokenizer treats `_`/`$`/`.` as word characters) and the query adds the
 *     split parts, so both directions work.
 *
 * Returns `null` when nothing usable survives, in which case the caller falls
 * back to vector-only retrieval.
 */
export function buildFtsQuery(question: string): string | null {
  const rawTerms = question.match(/[A-Za-z_$][\w$.]*|\d+/g) ?? [];
  const terms = new Set<string>();

  for (const raw of rawTerms) {
    const lower = raw.toLowerCase();
    if (lower.length < 2 || lower.length > 64) continue;

    const isIdentifier = /[A-Z_$.]/.test(raw) && raw.length > 2;
    if (!isIdentifier && STOPWORDS.has(lower)) continue;

    terms.add(lower);

    // camelCase / PascalCase / snake_case / dotted → component words
    if (isIdentifier) {
      for (const part of raw.split(/[_$.]|(?<=[a-z0-9])(?=[A-Z])/)) {
        const p = part.toLowerCase();
        if (p.length >= 3 && !STOPWORDS.has(p)) terms.add(p);
      }
    }
  }

  if (terms.size === 0) return null;

  // Quote every term so FTS5 treats it as a literal, never as an operator.
  // Embedded quotes are doubled per FTS5's own escaping rule.
  return [...terms]
    .slice(0, 24)
    .map((term) => `"${term.replace(/"/g, '""')}"`)
    .join(" OR ");
}
