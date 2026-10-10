import { forceUnicodeGlyphs } from '#testing/helpers/glyphs.js';
import { createElement } from 'react';
import { TaskSummary } from '../../../../components/task-summary.js';
import { renderFeature } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import {
  groupEventsIntoSections,
  type StageSummary,
} from '../../../../core/sections/event-sections.js';
import { EngineEventSchema } from '../../../../engine/events/schema.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { stageSummaryRow } from './stage-summary.js';

beforeEach(forceUnicodeGlyphs);

describe('stageSummaryRow', () => {
  it('omits the absent task anchor from a schema-valid review completion', () => {
    const event = EngineEventSchema.parse({
      type: 'review_completed',
      ts: 50_000,
      phase: 'implementing',
      scope: 'task',
      tool: 'codex',
      verdict: 'no-verdict',
      duration: 49_000,
    });
    const [section] = groupEventsIntoSections([event]);
    expect(section?.type).toBe('settled-stage');
    if (section?.type !== 'settled-stage') throw new Error('expected a settled review');
    expect(stageSummaryRow(section.summary)).toEqual({
      id: 'Review',
      title: 'no verdict',
      state: { kind: 'stage', outcome: 'no-verdict', detail: ['49.0s'] },
    });
  });

  it.each([
    ['final', 'passed', undefined, '✓ Review 1 passed  1m 2s'],
    ['final', 'passed-with-notes', { blocking: 0, minor: 2 }, '✓ Review 1 passed  2 notes · 1m 2s'],
    [
      'final',
      'failed',
      { blocking: 2, minor: 0 },
      '✗ Review 1 failed  2 blocking · npm test, 1 check · fixes T006 · 1m 2s',
    ],
    ['task', 'passed', undefined, '✓ Review T001 passed  1m 2s'],
    [
      'task',
      'failed',
      { blocking: 1, minor: 0 },
      '✗ Review T001 failed  1 blocking · npm test, 1 check · fixes T006 · 1m 2s',
    ],
    ['final', 'no-verdict', undefined, '✗ Review 1 no verdict  1m 2s'],
    ['task', 'stopped', undefined, '× Review T001 stopped  1m 2s'],
  ] as const)(
    'renders %s %s with the review marker and verdict',
    (scope, outcome, findings, expected) => {
      const summary: StageSummary = {
        stage: 'review',
        scope,
        afterTaskId: scope === 'task' ? 'T001' : undefined,
        ordinal: 1,
        outcome,
        findings,
        failedCommands: outcome === 'failed' ? ['npm test'] : [],
        failedChecks: outcome === 'failed' ? 1 : 0,
        fixes: outcome === 'failed' ? ['T006'] : [],
        duration: 62_000,
      };
      const ui = renderFeature(
        createElement(TaskSummary, { ...stageSummaryRow(summary), width: 120 }),
        { cols: 120, rows: 24 },
      );
      expect(stripAnsiStyles(ui.lastFrame()).trim()).toBe(expected);
      ui.unmount();
    },
  );

  it('keeps a failed terminal verdict red even when no fixes are appended', () => {
    expect(
      stageSummaryRow({
        stage: 'review',
        scope: 'final',
        ordinal: 2,
        outcome: 'failed',
        failedCommands: [],
        failedChecks: 0,
        fixes: [],
        duration: 5_000,
      }),
    ).toEqual({
      id: 'Review 2',
      title: '',
      state: { kind: 'stage', outcome: 'failed', detail: ['5.0s'] },
    });
  });
  it('names the plan by the run it planned and how long it took', () => {
    expect(
      stageSummaryRow({ stage: 'plan', feature: 'Fix the red tests', duration: 8_000 }),
    ).toEqual({
      id: 'Plan',
      title: 'Fix the red tests',
      state: { kind: 'stage', outcome: 'passed', detail: ['8.0s'] },
    });
  });

  it('says what failed in a review cycle and which fix briefs it appended', () => {
    expect(
      stageSummaryRow({
        stage: 'review',
        scope: 'final',
        outcome: 'failed',
        ordinal: 1,
        failedCommands: ['npm test'],
        failedChecks: 1,
        fixes: ['T006', 'T007', 'T008'],
        duration: 2_834_200,
      }),
    ).toEqual({
      id: 'Review 1',
      title: '',
      state: {
        kind: 'stage',
        outcome: 'failed',
        detail: ['npm test, 1 check', 'fixes T006 T007 T008', '47m 14s'],
      },
    });
  });

  it('lists every failed suite command and counts the failed checks', () => {
    expect(
      stageSummaryRow({
        stage: 'review',
        scope: 'final',
        outcome: 'failed',
        ordinal: 2,
        failedCommands: ['npm run typecheck', 'npm test'],
        failedChecks: 3,
        fixes: ['T009'],
        duration: 1_000,
      }).state,
    ).toEqual({
      kind: 'stage',
      outcome: 'failed',
      detail: ['npm run typecheck, npm test, 3 checks', 'fixes T009', '1.0s'],
    });
  });

  it('reads failed when the review verdict, not a suite stage or a check, sent the run back', () => {
    expect(
      stageSummaryRow({
        stage: 'review',
        scope: 'final',
        outcome: 'failed',
        ordinal: 1,
        failedCommands: [],
        failedChecks: 0,
        fixes: ['T004'],
        duration: 1_000,
      }),
    ).toEqual({
      id: 'Review 1',
      title: '',
      state: { kind: 'stage', outcome: 'failed', detail: ['fixes T004', '1.0s'] },
    });
  });

  it('reads passed for a review the build went on from', () => {
    expect(
      stageSummaryRow({
        stage: 'review',
        scope: 'final',
        outcome: 'passed',
        ordinal: 1,
        failedCommands: [],
        failedChecks: 0,
        fixes: [],
        duration: 1_000,
      }),
    ).toEqual({
      id: 'Review 1',
      title: 'passed',
      state: { kind: 'stage', outcome: 'passed', detail: ['1.0s'] },
    });
  });
});
