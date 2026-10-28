import { forceUnicodeGlyphs } from '#testing/helpers/glyphs.js';
import { createElement } from 'react';
import { TaskSummary } from '../../../../components/task-summary.js';
import { renderFeature } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import {
  groupEventsIntoSections,
  type StageSummary,
} from '../../../../core/sections/event-sections.js';
import { interruptedCallEvents } from '../../../../engine/calls/interrupted.js';
import { EngineEventSchema } from '../../../../engine/events/schema.js';
import type { EngineEvent } from '../../../../engine/events/types.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { stageSummaryRow } from './stage-summary.js';

beforeEach(forceUnicodeGlyphs);

describe('stageSummaryRow', () => {
  it('returns the heading spans that supply its text and colors', () => {
    expect(
      stageSummaryRow({
        stage: 'review',
        scope: 'task',
        afterTaskId: 'T001',
        fixCyclesBefore: 0,
        rerunsBefore: 0,
        outcome: 'stopped',
        failedCommands: [],
        failedChecks: 0,
        fixes: [],
        duration: 1_000,
      }),
    ).toMatchObject({
      state: {
        headingParts: {
          id: [
            { text: 'Review', tone: 'reviewer' },
            { text: ' T001', tone: 'textDim' },
          ],
          title: { text: 'stopped', tone: 'warning' },
        },
      },
    });
  });
  it('keeps the words of a task written on two lines apart in the Plan heading', () => {
    expect(
      stageSummaryRow({ stage: 'plan', feature: 'Add fixtures,\nas one task', duration: 1_000 })
        .state.headingParts.title,
    ).toEqual({ text: 'Add fixtures, as one task', tone: 'text' });
  });
  it.each([
    ['a process exit', 'exit', 'at least 3.0s'],
    ['your stop', 'stop', '3.0s'],
  ] as const)('reads a review cut by %s with the duration it knows', (_cause, cut, detail) => {
    const call = {
      phase: 'final-review',
      callId: 'review-1',
      role: 'review',
      backendKind: 'cli',
      sequence: 3,
    } as const;
    const before: EngineEvent[] = [
      { type: 'review_started', ts: 1_000, phase: 'final-review', scope: 'final', tool: 'codex' },
      {
        type: 'review_checks',
        ts: 4_000,
        phase: 'final-review',
        scope: 'final',
        status: 'planned',
        commands: [{ id: 'V1', command: 'npm test', reason: 'Verify the change.' }],
      },
      { type: 'runner_call_started', ts: 4_000, ...call },
    ];
    // A stop you make ends the call at its moment; the stop event itself may land in another section.
    const end: EngineEvent[] =
      cut === 'exit'
        ? interruptedCallEvents(before, '/repo')
        : [
            {
              type: 'runner_call_activity',
              ts: 4_000,
              ...call,
              activityId: 'review-1:terminal',
              stage: 'aborted',
              kind: 'error',
              label: 'aborted runner_interrupted',
              diagnosticPartial: 'stopped by you',
              redacted: false,
            },
          ];
    const events = [
      ...before,
      ...end,
      { type: 'workflow_resumed', ts: 65_000, phase: 'final-review' },
    ].map((event) => EngineEventSchema.parse(event));
    const [section] = groupEventsIntoSections(events);
    if (section?.type !== 'settled-stage') throw new Error('expected a settled review');
    expect(stageSummaryRow(section.summary)).toMatchObject({
      state: { kind: 'stage', outcome: 'stopped', detail: [detail] },
    });
  });

  it.each([
    ['a known end', {}],
    ['no known end', { endUnknown: true as const }],
  ])('shows no clock on a stopped review that ran no measurable time, with %s', (_end, end) => {
    expect(
      stageSummaryRow({
        stage: 'review',
        scope: 'final',
        fixCyclesBefore: 0,
        rerunsBefore: 0,
        outcome: 'stopped',
        failedCommands: [],
        failedChecks: 0,
        fixes: [],
        duration: 1,
        ...end,
      }),
    ).toMatchObject({ state: { kind: 'stage', outcome: 'stopped', detail: [] } });
  });

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
    expect(stageSummaryRow(section.summary)).toMatchObject({
      state: { kind: 'stage', outcome: 'no-verdict', detail: ['49.0s'] },
    });
  });

  it.each([
    ['final', 'passed', undefined, '● Final review passed  1m 2s'],
    [
      'final',
      'passed-with-notes',
      { blocking: 0, minor: 2 },
      '● Final review passed  2 notes · 1m 2s',
    ],
    [
      'final',
      'failed',
      { blocking: 2, minor: 0 },
      '✗ Final review failed  2 blocking · npm test, 1 check · fixes T006 · 1m 2s',
    ],
    ['task', 'passed', undefined, '● Review T001 passed  1m 2s'],
    [
      'task',
      'passed-with-notes',
      { blocking: 0, minor: 0, outOfScope: 1 },
      '● Review T001 passed  1 note · 1m 2s',
    ],
    [
      'task',
      'passed-with-notes',
      { blocking: 0, minor: 0, outOfScope: 3 },
      '● Review T001 passed  3 notes · 1m 2s',
    ],
    [
      'final',
      'passed-with-notes',
      { blocking: 0, minor: 2, outOfScope: 3 },
      '● Final review passed  5 notes · 1m 2s',
    ],
    [
      'task',
      'failed',
      { blocking: 1, minor: 0 },
      '✗ Review T001 failed  1 blocking · npm test, 1 check · fixes T006 · 1m 2s',
    ],
    ['final', 'no-verdict', undefined, '✗ Final review no verdict  1m 2s'],
    ['task', 'stopped', undefined, '× Review T001 stopped  1m 2s'],
  ] as const)(
    'renders %s %s with the review marker and verdict',
    (scope, outcome, findings, expected) => {
      const summary: StageSummary = {
        stage: 'review',
        scope,
        afterTaskId: scope === 'task' ? 'T001' : undefined,
        fixCyclesBefore: 0,
        rerunsBefore: 0,
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

  it('names the verify step of a review a stop cut', () => {
    const ui = renderFeature(
      createElement(TaskSummary, {
        ...stageSummaryRow({
          stage: 'review',
          scope: 'final',
          fixCyclesBefore: 0,
          rerunsBefore: 0,
          outcome: 'stopped',
          stoppedDuring: 'verify',
          failedCommands: [],
          failedChecks: 0,
          fixes: [],
          duration: 62_000,
        }),
        width: 120,
      }),
      { cols: 120, rows: 24 },
    );
    expect(stripAnsiStyles(ui.lastFrame()).trim()).toBe(
      '× Final review stopped during verify  1m 2s',
    );
    ui.unmount();
  });

  it('names a final review after a fix cycle by the cycles before it, not by a bare count', () => {
    const ui = renderFeature(
      createElement(TaskSummary, {
        ...stageSummaryRow({
          stage: 'review',
          scope: 'final',
          fixCyclesBefore: 1,
          rerunsBefore: 0,
          outcome: 'passed',
          failedCommands: [],
          failedChecks: 0,
          fixes: [],
          duration: 26_400,
        }),
        width: 120,
      }),
      { cols: 120, rows: 24 },
    );
    expect(stripAnsiStyles(ui.lastFrame()).trim()).toBe(
      '● Final review after 1 fix cycle passed  26.4s',
    );
    ui.unmount();
  });

  it('keeps a failed terminal verdict red even when no fixes are appended', () => {
    expect(
      stageSummaryRow({
        stage: 'review',
        scope: 'final',
        fixCyclesBefore: 1,
        rerunsBefore: 0,
        outcome: 'failed',
        failedCommands: [],
        failedChecks: 0,
        fixes: [],
        duration: 5_000,
      }),
    ).toMatchObject({
      state: { kind: 'stage', outcome: 'failed', detail: ['5.0s'] },
    });
  });
  it('names the plan by the run it planned and how long it took', () => {
    expect(
      stageSummaryRow({ stage: 'plan', feature: 'Fix the red tests', duration: 8_000 }),
    ).toMatchObject({
      state: { kind: 'stage', outcome: 'passed', detail: ['8.0s'] },
    });
  });

  it('says what failed in a review cycle and which fix briefs it appended', () => {
    expect(
      stageSummaryRow({
        stage: 'review',
        scope: 'final',
        outcome: 'failed',
        fixCyclesBefore: 0,
        rerunsBefore: 0,
        failedCommands: ['npm test'],
        failedChecks: 1,
        fixes: ['T006', 'T007', 'T008'],
        duration: 2_834_200,
      }),
    ).toMatchObject({
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
        fixCyclesBefore: 1,
        rerunsBefore: 0,
        failedCommands: ['npm run typecheck', 'npm test'],
        failedChecks: 3,
        fixes: ['T009'],
        duration: 1_000,
      }).state,
    ).toMatchObject({
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
        fixCyclesBefore: 0,
        rerunsBefore: 0,
        failedCommands: [],
        failedChecks: 0,
        fixes: ['T004'],
        duration: 1_000,
      }),
    ).toMatchObject({
      state: {
        kind: 'stage',
        outcome: 'failed',
        detail: ['fixes T004', '1.0s'],
      },
    });
  });

  it('reads passed for a review the build went on from', () => {
    expect(
      stageSummaryRow({
        stage: 'review',
        scope: 'final',
        outcome: 'passed',
        fixCyclesBefore: 0,
        rerunsBefore: 0,
        failedCommands: [],
        failedChecks: 0,
        fixes: [],
        duration: 1_000,
      }),
    ).toMatchObject({
      state: { kind: 'stage', outcome: 'passed', detail: ['1.0s'] },
    });
  });
});
