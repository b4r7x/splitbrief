import { REVIEW_VERDICTS } from '../schemas/enums.js';

export const REVIEW_CYCLE_CAP = 2;

export const VERDICT_RULES = {
  words: REVIEW_VERDICTS,
  exactlyOne: true,
  unparseableReask: 1,
  unparseableVerdict: 'fail',
  criticalOverridesPass: true,
  findingOwner: 'path-substring-of-files',
  unmatchedFindingOwner: 'last-brief',
  reaskSentence:
    'Your reply had no single verdict. Repeat the full review with exactly one verdict word under ### Verdict.',
} as const;
