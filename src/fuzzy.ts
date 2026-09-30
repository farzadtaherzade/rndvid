/**
 * Subsequence fuzzy matcher with positional scoring.
 *
 * Not full Levenshtein: a strict subsequence match is more predictable for
 * browsing file and folder names, where you usually know the first few
 * characters. Ranking rewards consecutive runs and matches at word boundaries,
 * so "smk" ranks "some movie.mkv" above "summer kickback 2019.mkv".
 */
export function fuzzyScore(query: string, target: string): number | null {
  if (query === "") return 0;

  const q = query.toLowerCase();
  const t = target.toLowerCase();

  let targetIndex = 0;
  let score = 0;
  let streak = 0;

  for (let qIndex = 0; qIndex < q.length; qIndex += 1) {
    const needle = q[qIndex]!;
    const found = t.indexOf(needle, targetIndex);
    if (found === -1) return null;

    if (found === targetIndex && qIndex > 0) {
      streak += 1;
      score += 12 + streak * 6;
    } else {
      streak = 0;
      score += 10;
    }

    if (found === 0) score += 20; // start of the string
    else {
      const previous = t[found - 1]!;
      // Boundary after a separator scores like a word start.
      if (previous === " " || previous === "\\" || previous === "/" || previous === "_" || previous === "-" || previous === ".") {
        score += 14;
      }
    }

    targetIndex = found + 1;
  }

  // Prefer tighter matches: every unmatched character costs a little.
  score -= (t.length - q.length) * 0.5;
  return score;
}

export interface Scored<T> {
  item: T;
  score: number;
  index: number;
}

/**
 * Filter and rank `items` against `query`, keeping input order as the tiebreaker.
 * An empty query returns everything unfiltered, preserving the caller's sort.
 */
export function fuzzyFilter<T>(
  items: readonly T[],
  query: string,
  toText: (item: T) => string,
): Scored<T>[] {
  if (query === "") {
    return items.map((item, index) => ({ item, score: 0, index }));
  }

  const scored: Scored<T>[] = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]!;
    const score = fuzzyScore(query, toText(item));
    if (score !== null) scored.push({ item, score, index });
  }
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored;
}
