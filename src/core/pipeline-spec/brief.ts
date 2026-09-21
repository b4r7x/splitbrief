/** Render order of the implementer body; `### Current Code` sits after Pattern. */
export const BRIEF_SECTION_ORDER = [
  '### Description',
  '### Signature',
  '### Type Definitions',
  '### Pattern',
  '### Current Code',
  '### Implementation Steps',
  '### Tests',
  '### Scope',
  '### Escalation',
  '### Evidence',
  '### Constraints',
] as const;

export const CLOSING_CONSTRAINTS = [
  'Do NOT invent new functions not described in the task',
  'Do NOT add features not described in the task',
  'Do NOT import packages not listed in the project dependencies',
] as const;

export const SLICE_BUDGET = { maxFiles: 5, maxChangedLoc: 200, frontierMaxFiles: 8 } as const;

/** The one authored slice rule; prompts and skill blocks render it rather than restating it. */
export function sliceRuleText(opts?: { briefCap?: number }): string {
  const cap = opts?.briefCap === undefined ? '' : ` Emit at most ${opts.briefCap} briefs in all.`;
  return `One brief = one verifiable slice — the code, its test and its wiring that one gate run can prove together. List every file it writes under \`files\`; one file is the smallest slice. Split when a gate can pass on one part without the other. Budget: at most ${SLICE_BUDGET.maxFiles} files and about ${SLICE_BUDGET.maxChangedLoc} changed lines per brief for a mid-tier implementer; a frontier implementer may take ${SLICE_BUDGET.frontierMaxFiles}. A brief whose only purpose is to test a sibling another brief creates is folded into that brief.${cap}`;
}

export const PLAN_PROMPT_MAX_BYTES = 110_000;
