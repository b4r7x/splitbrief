import { Fzf, type FzfResultItem } from 'fzf';

export type FuzzyMatchResult = {
  score: number;
  positions: number[];
};

export function fuzzyMatch(query: string, target: string): FuzzyMatchResult | null {
  if (query.length === 0) return { score: 0, positions: [] };
  const lowerTarget = target.toLowerCase();
  const fzf = new Fzf([lowerTarget]);
  const results = fzf.find(query.toLowerCase());
  const top = results[0];
  if (top === undefined || top.score <= 0) return null;
  return { score: Math.min(1, top.score / 100), positions: Array.from(top.positions as Set<number>).sort((a, b) => a - b) };
}

export function fuzzyMatchExtended(query: string, target: string): FuzzyMatchResult | null {
  const terms = query.trim().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return { score: 0, positions: [] };
  let totalScore = 0;
  const allPositions = new Set<number>();
  for (const term of terms) {
    const result = fuzzyMatch(term, target);
    if (result === null) return null;
    totalScore += result.score;
    for (const p of result.positions) allPositions.add(p);
  }
  return { score: totalScore, positions: Array.from(allPositions).sort((a, b) => a - b) };
}

export function fuzzyRank<T>(items: T[], query: string, selector: (item: T) => string): T[] {
  if (!query) return items;
  const fzf = new Fzf(items, { selector });
  return fzf.find(query).map((r: FzfResultItem<T>) => r.item);
}
