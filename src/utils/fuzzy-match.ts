export type FuzzyMatchResult = {
  score: number;
  positions: number[];
};

/**
 * Returns null when query does not subsequence-match target.
 * Case-insensitive. Empty query always returns { score: 0, positions: [] }.
 */
export function fuzzyMatch(query: string, target: string): FuzzyMatchResult | null {
  const q = query.toLowerCase();
  const t = target.toLowerCase();

  if (q.length === 0) return { score: 0, positions: [] };
  if (q === t) {
    return { score: 1, positions: Array.from({ length: t.length }, (_, i) => i) };
  }

  const positions: number[] = [];
  let ti = 0;

  for (let qi = 0; qi < q.length; qi++) {
    let found = false;
    while (ti < t.length) {
      if (t[ti] === q[qi]) {
        positions.push(ti);
        ti++;
        found = true;
        break;
      }
      ti++;
    }
    if (!found) return null;
  }

  const matchedCount = positions.length;
  const targetLen = t.length;
  const firstMatchIndex = positions[0] ?? 0;

  const baseScore = targetLen === 0 ? 0 : matchedCount / targetLen;
  const positionBonus = targetLen === 0 ? 0 : 1 - firstMatchIndex / targetLen;

  let longestRun = 1;
  let currentRun = 1;
  for (let i = 1; i < positions.length; i++) {
    if ((positions[i] ?? 0) === (positions[i - 1] ?? 0) + 1) {
      currentRun++;
      if (currentRun > longestRun) longestRun = currentRun;
    } else {
      currentRun = 1;
    }
  }
  const consecutiveBonus = matchedCount === 0 ? 0 : longestRun / matchedCount;

  const wordBoundaryChars = new Set([' ', '-', '_', '/']);
  let wbSum = 0;
  for (const p of positions) {
    if (p === 0 || wordBoundaryChars.has(t[p - 1] ?? '')) {
      wbSum += 0.1;
    }
  }
  const wbBonus = Math.min(wbSum, 1.0);

  const raw =
    baseScore * 0.4 + positionBonus * 0.3 + consecutiveBonus * 0.2 + wbBonus * 0.1;

  const finalScore = Math.min(1, Math.max(0, Number.isFinite(raw) ? raw : 0));

  return { score: finalScore, positions };
}

/**
 * Scores a target against multiple space-separated terms.
 * All terms must match; returns null if any term fails.
 * Total score is the sum of per-term scores (not averaged).
 */
export function fuzzyMatchExtended(query: string, target: string): FuzzyMatchResult | null {
  const terms = query
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (terms.length === 0) return { score: 0, positions: [] };

  let totalScore = 0;
  const allPositions = new Set<number>();

  for (const term of terms) {
    const result = fuzzyMatch(term, target);
    if (result === null) return null;
    totalScore += result.score;
    for (const p of result.positions) allPositions.add(p);
  }

  const positions = Array.from(allPositions).sort((a, b) => a - b);

  return { score: totalScore, positions };
}
