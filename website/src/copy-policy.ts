export interface CopyPolicyOptions {
  readonly allowCostVocabulary?: boolean;
  readonly allowSavingsClaims?: boolean;
}

export interface CopyPolicyViolation {
  readonly kind: 'banned-term' | 'cost-vocabulary' | 'savings-claim';
  readonly match: string;
}

const BANNED_TERM_PATTERNS = [
  /\bsupercharge\b/giu,
  /(?<![\p{L}\p{N}_])10[x×](?![\p{L}\p{N}_])/giu,
  /\bai\s*[-–—]?\s*powered\b/giu,
  /\bseamless\b/giu,
  /\bblazingly\s+fast\b/giu,
  /\bunleash\b/giu,
  /\beffortless\b/giu,
] as const;

const COST_VOCABULARY_PATTERN = /\bcheap(?:er|est|ly)?\b/giu;
const PERCENTAGE_PATTERN = /\b\d+(?:\.\d+)?\s*%/gu;
const SAVINGS_TERM_PATTERN =
  /\b(?:sav(?:e(?:d|s)?|ing|ings)|reduc(?:e(?:d|s)?|ing|tion|tions)|cut(?:s|ting)?|fewer|less|cheaper)\b/giu;
const CLAUSE_BOUNDARY_PATTERN = /[.!?;]/u;
const THRESHOLD_CONTEXT_PATTERN =
  /\b(?:alert|budget|cap|limit|maximum|max|pause|quota|threshold|usage|utilization|warn)\b/iu;
const SAVINGS_PROXIMITY_LIMIT = 120;

interface TextMatch {
  readonly end: number;
  readonly start: number;
  readonly value: string;
}

export function normalizeCopyText(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

export function findCopyPolicyViolations(
  value: string,
  options: CopyPolicyOptions = {},
): readonly CopyPolicyViolation[] {
  const text = normalizeCopyText(value);
  const violations: CopyPolicyViolation[] = BANNED_TERM_PATTERNS.flatMap((pattern) =>
    [...text.matchAll(pattern)].map((match) => ({
      kind: 'banned-term' as const,
      match: match[0],
    })),
  );

  if (!options.allowCostVocabulary) {
    violations.push(
      ...[...text.matchAll(COST_VOCABULARY_PATTERN)].map((match) => ({
        kind: 'cost-vocabulary' as const,
        match: match[0],
      })),
    );
  }

  if (!options.allowSavingsClaims) {
    violations.push(...findSavingsClaims(text));
  }

  return violations;
}

function findSavingsClaims(text: string): CopyPolicyViolation[] {
  const percentages = collectMatches(text, PERCENTAGE_PATTERN);
  const savingsTerms = collectMatches(text, SAVINGS_TERM_PATTERN);
  const claimedRanges = new Set<string>();
  const violations: CopyPolicyViolation[] = [];

  for (const percentage of percentages) {
    const clause = clauseRange(text, percentage.start);
    const candidate = nearestSavingsTerm(percentage, savingsTerms, clause);
    if (
      !candidate ||
      isBudgetThresholdComparison(text.slice(clause.start, clause.end), candidate)
    ) {
      continue;
    }

    const start = Math.min(percentage.start, candidate.start);
    const end = Math.max(percentage.end, candidate.end);
    const rangeKey = `${start}:${end}`;
    if (claimedRanges.has(rangeKey)) {
      continue;
    }

    claimedRanges.add(rangeKey);
    violations.push({
      kind: 'savings-claim',
      match: text.slice(start, end),
    });
  }

  return violations;
}

function collectMatches(text: string, pattern: RegExp): TextMatch[] {
  return [...text.matchAll(pattern)].flatMap((match) => {
    if (match.index === undefined) {
      return [];
    }

    return [
      {
        end: match.index + match[0].length,
        start: match.index,
        value: match[0],
      },
    ];
  });
}

function clauseRange(
  text: string,
  index: number,
): { readonly end: number; readonly start: number } {
  const before = text.slice(0, index);
  const reversedBoundary = [...before]
    .reverse()
    .findIndex((character) => CLAUSE_BOUNDARY_PATTERN.test(character));
  const start = reversedBoundary === -1 ? 0 : index - reversedBoundary;
  const afterBoundary = text.slice(index).search(CLAUSE_BOUNDARY_PATTERN);
  const end = afterBoundary === -1 ? text.length : index + afterBoundary;

  return { end, start };
}

function nearestSavingsTerm(
  percentage: TextMatch,
  savingsTerms: readonly TextMatch[],
  clause: { readonly end: number; readonly start: number },
): TextMatch | undefined {
  return savingsTerms
    .filter(
      (term) =>
        term.start >= clause.start &&
        term.end <= clause.end &&
        distanceBetween(term, percentage) <= SAVINGS_PROXIMITY_LIMIT,
    )
    .sort(
      (left, right) => distanceBetween(left, percentage) - distanceBetween(right, percentage),
    )[0];
}

function distanceBetween(left: TextMatch, right: TextMatch): number {
  if (left.end < right.start) {
    return right.start - left.end;
  }
  if (right.end < left.start) {
    return left.start - right.end;
  }
  return 0;
}

function isBudgetThresholdComparison(clause: string, savingsTerm: TextMatch): boolean {
  if (!/^(?:fewer|less)$/iu.test(savingsTerm.value) || !THRESHOLD_CONTEXT_PATTERN.test(clause)) {
    return false;
  }

  return (
    /\b(?:fewer|less)\s+than\s+\d+(?:\.\d+)?\s*%/iu.test(clause) ||
    /\b\d+(?:\.\d+)?\s*%\s+or\s+(?:fewer|less)\b/iu.test(clause)
  );
}
