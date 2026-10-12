import type { SummaryView } from '../../../src/features/workflow/closed/view-model.js';
import { taskId } from '../../../src/core/schemas/task.js';
import { getRailStages } from '../../../src/core/rail-stages.js';

/** A width no line ever has to shed a fact to fit. */
export const WIDE = 200;

export function makeView(overrides: Partial<SummaryView> = {}): SummaryView {
  return {
    outcome: { kind: 'complete' },
    run: {
      feature: 'Add email validation with tests',
      sessionId: '2026-09-14-add-email-validation-with-tests',
    },
    rail: getRailStages('complete'),
    seats: {
      plan: { kind: 'named', short: 'claude-sonnet-4' },
      build: { kind: 'named', short: 'qwen2.5-coder:7b' },
      review: { kind: 'inherits' },
    },
    briefs: {
      total: 3,
      passed: 3,
      failed: 0,
      rows: [],
      earlierRows: [],
    },
    review: {
      kind: 'written',
      verdict: 'pass_with_notes',
      counts: { critical: 0, warning: 1, note: 0 },
      markdownPath: 'review-packet.md',
      evidence: { validated: 3, total: 3 },
      missingArtifacts: 0,
    },
    scope: { kind: 'checked', passed: true, errors: 0, warnings: 0 },
    quality: null,
    files: {
      changed: ['src/form.test.ts', 'src/form.ts', 'src/routes/signup.test.ts', 'src/validate.ts'],
      partial: new Set<string>(),
      stoppedAt: null,
      patch: null,
    },
    checkpoint: null,
    canUndoApply: overrides.outcome?.kind === 'applied',
    applyUndo: null,
    phases: [
      { phase: 'planning', ms: 170_000 },
      { phase: 'implementing', ms: 492_000 },
      { phase: 'review', ms: 65_000 },
    ],
    ...overrides,
  };
}

export function endedInBuild(overrides: Partial<SummaryView> = {}): SummaryView {
  return makeView({
    outcome: { kind: 'ended' },
    rail: getRailStages('implementing', { halted: 'cancelled' }),
    briefs: {
      total: 5,
      passed: 2,
      failed: 0,
      rows: [],
      earlierRows: [],
    },
    review: { kind: 'not-run' },
    scope: { kind: 'not-run' },
    files: {
      changed: ['src/routes/signup.ts', 'src/validate.ts'],
      partial: new Set(['src/routes/signup.ts']),
      stoppedAt: { taskId: taskId('T003') },
      patch: null,
    },
    ...overrides,
  });
}

export function endedInPlanning(overrides: Partial<SummaryView> = {}): SummaryView {
  return makeView({
    outcome: { kind: 'ended' },
    rail: getRailStages('planning', { halted: 'cancelled' }),
    briefs: {
      total: 0,
      passed: 0,
      failed: 0,
      rows: [],
      earlierRows: [],
    },
    review: { kind: 'not-run' },
    scope: { kind: 'not-run' },
    files: { changed: null, partial: new Set(), stoppedAt: null, patch: null },
    phases: [],
    ...overrides,
  });
}
