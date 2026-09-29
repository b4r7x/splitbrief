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

/** The one authored grouping rule; prompts and skill blocks render it rather than restating it. */
export function sliceRuleText(): string {
  return [
    'One brief delivers one coherent, reviewable outcome. List every path that outcome writes under `files`.',
    'Keep the tests, callers, wiring, fixtures and necessary documentation with the behavior they cover; a file boundary alone never makes a separate brief.',
    'Combine related corrections that share a contract, mechanism or code context; a mechanical rename carries all its callers and pinned strings.',
    'Split independent outcomes, or a complex mechanism, when separate validation, context or recovery makes the work easier to execute correctly.',
    'Two assertions that can pass separately do not require separate briefs, and no file-count or line-count threshold decides a boundary.',
    'Keep each brief self-contained for its actual runner, with every acceptance criterion and repository constraint it needs, and within the real model context and prompt transport limits, system text, skills and retry feedback included.',
    'Do not aim for a number of briefs. Order the dependencies so each brief leaves its affected checks green.',
  ].join(' ');
}

export const PLAN_PROMPT_MAX_BYTES = 110_000;
