/**
 * English stopwords plus the question vocabulary developers actually use.
 *
 * Postgres's 'simple' text search configuration does no stopword removal by
 * design — that is why it was chosen for indexing code, where `in`, `to` and
 * `not` are real identifiers. The consequence is that stopword removal has to
 * happen here instead: without it, "how does the app handle errors" matches
 * essentially every chunk on "the", "does" and "how", and the sparse ranking
 * degenerates into noise that pollutes the fused result.
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
  "repo", "repository", "project", "please",
]);

/**
 * Extract the search terms from a natural-language question.
 *
 * **camelCase splitting** is the reason this exists rather than handing the
 * raw question to `plainto_tsquery`. A user asking about "the auth middleware"
 * should match `authMiddleware`, and someone pasting `getUserById` should match
 * prose about "get user by id". Postgres's 'simple' parser lowercases but does
 * not split identifiers, so the query side emits both the whole token and its
 * parts and lets whichever one exists in the index win.
 *
 * Returns `[]` when nothing usable survives, in which case the caller falls
 * back to vector-only retrieval.
 */
export function extractSearchTerms(question: string): string[] {
  const rawTerms = question.match(/[A-Za-z_$][\w$.]*|\d+/g) ?? [];
  const terms = new Set<string>();

  for (const raw of rawTerms) {
    const lower = raw.toLowerCase();
    if (lower.length < 2 || lower.length > 64) continue;

    const identifier = looksLikeIdentifier(raw);
    // Identifiers are exempt from the stopword list — a symbol genuinely named
    // `use` or `for` must still be searchable.
    if (!identifier && STOPWORDS.has(lower)) continue;

    terms.add(lower);

    if (identifier) {
      for (const part of raw.split(/[_$.]|(?<=[a-z0-9])(?=[A-Z])/)) {
        const p = part.toLowerCase();
        if (p.length >= 3 && !STOPWORDS.has(p)) terms.add(p);
      }
    }
  }

  return [...terms].slice(0, 24);
}

/**
 * Does this token look like a code symbol rather than an English word?
 *
 * Getting this wrong is expensive in one specific direction, and I got it wrong
 * the first time: the original test was "contains an uppercase letter, `_`, `$`
 * or `.`", which makes every sentence-initial capital an identifier. "How does
 * the view engine render?" therefore searched for `how`, exempting it from the
 * stopword list and putting the single most common word in English into the
 * lexical query — precisely the noise the stopword list exists to remove. It
 * showed up in a production trace as `how | view | engine | resolve | ...`.
 *
 * So a leading capital is not evidence. Real evidence is:
 *   - punctuation that English words do not have: `_`, `$`, `.`
 *   - an *interior* case change (`parseJwt`, `ConfigStore`)
 *   - being a SCREAMING_CASE constant or acronym (`HTTP`)
 *
 * The deliberate miss: a single PascalCase word like `View` or `Router` is not
 * flagged. That costs nothing — such words are not stopwords, so they survive
 * anyway, and they have no camelCase parts worth splitting.
 */
function looksLikeIdentifier(raw: string): boolean {
  if (raw.length <= 2) return false;
  if (/[_$.]/.test(raw)) return true;
  if (/[a-z0-9][A-Z]/.test(raw)) return true;
  return /^[A-Z0-9]{3,}$/.test(raw);
}

/**
 * Build a `tsquery` string: the terms OR-ed together.
 *
 * **Safety.** `to_tsquery` parses a query language — `&`, `|`, `!`, `<->`,
 * parentheses and `:*` are all operators — so raw user text belongs nowhere
 * near it. Rather than escaping, every term is stripped down to
 * `[a-z0-9_]` here, which makes an operator unrepresentable by construction.
 * The result is still passed as a bind parameter, never interpolated.
 *
 * Terms that reduce to nothing (pure punctuation) are dropped; if that leaves
 * the query empty we return `null` and the caller skips the sparse retriever.
 */
export function buildTsQuery(question: string): string | null {
  const safe = extractSearchTerms(question)
    .map((term) => term.replace(/[^a-z0-9_]/g, ""))
    .filter((term) => term.length >= 2);

  if (safe.length === 0) return null;
  return [...new Set(safe)].join(" | ");
}
