export interface FusedResult {
  id: number;
  score: number;
  /** Which input list positions contributed, for debugging retrieval. */
  ranks: Array<number | null>;
}

/**
 * Reciprocal Rank Fusion (Cormack, Clarke & Buettcher, 2009).
 *
 *     score(d) = Σ_lists  1 / (k + rank(d))
 *
 * ## Why RRF rather than a weighted score blend
 * Cosine similarity and BM25 are not on the same scale, and BM25's range shifts
 * with corpus statistics — so `0.7 * cosine + 0.3 * bm25` requires per-corpus
 * normalisation and a weight that has to be re-tuned for every repository.
 * RRF throws away the magnitudes and keeps only the ordering, which is the part
 * that transfers. It needs no tuning and no normalisation, and it is robust
 * when one retriever returns garbage: a document ranked highly by both lists
 * beats one ranked first by a single list, which is exactly the behaviour we
 * want when a rare identifier and a paraphrase disagree.
 *
 * `k` damps the head of each list. At k=60 the gap between rank 1 and rank 2
 * is small, so a single over-confident retriever cannot dominate the fusion.
 */
export function reciprocalRankFusion(lists: number[][], k = 60): FusedResult[] {
  const scores = new Map<number, { score: number; ranks: Array<number | null> }>();

  lists.forEach((list, listIndex) => {
    list.forEach((id, position) => {
      const rank = position + 1;
      const existing = scores.get(id) ?? {
        score: 0,
        ranks: new Array<number | null>(lists.length).fill(null),
      };
      existing.score += 1 / (k + rank);
      existing.ranks[listIndex] = rank;
      scores.set(id, existing);
    });
  });

  return [...scores.entries()]
    .map(([id, value]) => ({ id, score: value.score, ranks: value.ranks }))
    .sort((a, b) => b.score - a.score || a.id - b.id);
}
