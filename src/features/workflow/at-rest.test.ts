import { describe, expect, it } from 'vitest';
import { makeRunRecord } from '#testing/helpers/factories/run-record.js';
import { makeWorkflowState } from '#testing/helpers/factories/workflow-state.js';
import type { WorkflowMode } from '../../core/schemas/enums.js';
import { taskId } from '../../core/schemas/task.js';
import type { RunStatus, StopReason } from '../../core/sessions/run-status.js';
import { makeRecoveryIssue } from '#testing/helpers/factories/recovery.js';
import { makeSummary } from '#testing/helpers/factories/summary.js';
import type { ReviewPacketSummary } from '../../core/schemas/summary.js';
import { atRestComposer, atRestRailStages, recordPhase } from './at-rest.js';

const PACKET: ReviewPacketSummary = {
  jsonPath: 'review-packet.json',
  markdownPath: 'review-packet.md',
  generatedAt: '2026-09-14T00:00:00.000Z',
  finalReviewStatus: 'written',
  finalReviewVerdict: 'pass_with_notes',
  finalReviewFindingCounts: { critical: 0, warning: 1, note: 0 },
  driftPassed: true,
  evidenceValidatedTasks: 3,
  evidenceTotalTasks: 3,
  missingArtifactCount: 0,
};

function openWith(stop: StopReason): RunStatus {
  return { kind: 'open', stop, resumeAt: { kind: 'brief', taskId: taskId('T002'), attempt: 0 } };
}

function recordAt(input: {
  status: RunStatus;
  phase?: 'researching' | 'implementing' | 'complete' | 'planning';
  mode?: WorkflowMode;
}) {
  return makeRunRecord({
    status: input.status,
    ...(input.mode !== undefined && { mode: input.mode }),
    ...(input.phase !== undefined && {
      hydration: { kind: 'loaded', state: makeWorkflowState({ phase: input.phase }) },
    }),
  });
}

describe('atRestRailStages', () => {
  it('marks all three stages done on a run that finished', () => {
    const stages = atRestRailStages(recordAt({ status: { kind: 'closed', as: 'complete' } }));
    expect(stages).toEqual([
      { stage: 'plan', status: 'done' },
      { stage: 'build', status: 'done' },
      { stage: 'review', status: 'done' },
    ]);
  });

  it('marks the stage a run somebody ended stopped on', () => {
    const stages = atRestRailStages(
      recordAt({ status: { kind: 'closed', as: 'ended' }, phase: 'implementing' }),
    );
    expect(stages.map((stage) => stage.status)).toEqual(['done', 'cancelled', 'pending']);
  });

  it.each([
    [
      'paused',
      { kind: 'stopped', on: { kind: 'paused', at: 'mid-step' } } satisfies StopReason,
      'cancelled',
    ],
    [
      'gate',
      {
        kind: 'waiting-for-you',
        on: { kind: 'gate', gate: 'spec', reopens: false },
      } satisfies StopReason,
      'cancelled',
    ],
    [
      'question',
      { kind: 'waiting-for-you', on: { kind: 'question' } } satisfies StopReason,
      'cancelled',
    ],
    [
      'halt',
      {
        kind: 'waiting-for-you',
        on: { kind: 'halt', issue: makeRecoveryIssue() },
      } satisfies StopReason,
      'failed',
    ],
    [
      'interrupted',
      { kind: 'stopped', on: { kind: 'interrupted' } } satisfies StopReason,
      'cancelled',
    ],
    [
      'failed',
      { kind: 'stopped', on: { kind: 'failed', message: 'boom' } } satisfies StopReason,
      'failed',
    ],
  ])('wears the %s mark the stop earned', (_label, stop, expected) => {
    const stages = atRestRailStages(recordAt({ status: openWith(stop), phase: 'implementing' }));
    expect(stages[1]?.status).toBe(expected);
  });

  it('leaves a run another process is driving on its active stage', () => {
    const stages = atRestRailStages(recordAt({ status: { kind: 'running' }, phase: 'planning' }));
    expect(stages[0]).toEqual({ stage: 'plan', status: 'active' });
  });

  it.each(['standard', 'quick', 'speckit'] as const)(
    'folds an old %s research stop into Plan',
    (mode) => {
      const stages = atRestRailStages(
        recordAt({
          status: openWith({ kind: 'stopped', on: { kind: 'interrupted' } }),
          phase: 'researching',
          mode,
        }),
      );
      expect(stages.map((stage) => stage.status)).toEqual(['cancelled', 'pending', 'pending']);
    },
  );
});

const WORKSPACE = {
  kind: 'worktree' as const,
  path: '/tmp/run-workspace',
  base: { snapshotId: 'workspace-base', head: null },
};

function workspaceRecord(status: RunStatus, phase: 'implementing' | 'complete' = 'complete') {
  return makeRunRecord({
    status,
    hydration: {
      kind: 'loaded',
      state: makeWorkflowState({ phase, workspace: WORKSPACE }),
    },
  });
}

describe('atRestRailStages on a run with a workspace', () => {
  it('adds a pending Apply stage after a passed review', () => {
    const stages = atRestRailStages(workspaceRecord({ kind: 'ready-to-apply', override: false }));
    expect(stages).toEqual([
      { stage: 'plan', status: 'done' },
      { stage: 'build', status: 'done' },
      { stage: 'review', status: 'done' },
      { stage: 'apply', status: 'pending' },
    ]);
  });

  it('marks Apply done on an applied run', () => {
    const stages = atRestRailStages(workspaceRecord({ kind: 'closed', as: 'applied' }));
    expect(stages.map((stage) => stage.status)).toEqual(['done', 'done', 'done', 'done']);
  });

  it('marks Apply cancelled on a discarded run', () => {
    const stages = atRestRailStages(workspaceRecord({ kind: 'closed', as: 'discarded' }));
    expect(stages.map((stage) => stage.status)).toEqual(['done', 'done', 'done', 'cancelled']);
  });

  it('adds no Apply stage to an ended run', () => {
    const stages = atRestRailStages(
      workspaceRecord({ kind: 'closed', as: 'ended' }, 'implementing'),
    );
    expect(stages).toEqual([
      { stage: 'plan', status: 'done' },
      { stage: 'build', status: 'cancelled' },
      { stage: 'review', status: 'pending' },
    ]);
  });

  // In a real run, End run on the failed-review halt read `● Plan → ● Build → ● Review → ○ Apply`.
  it('stops an ended run on the review that failed, with no Apply stage', () => {
    const stages = atRestRailStages(
      makeRunRecord({
        status: { kind: 'closed', as: 'ended' },
        hydration: {
          kind: 'loaded',
          state: makeWorkflowState({
            phase: 'complete',
            reviewStatus: 'failed',
            workspace: WORKSPACE,
          }),
        },
      }),
    );
    expect(stages).toEqual([
      { stage: 'plan', status: 'done' },
      { stage: 'build', status: 'done' },
      { stage: 'review', status: 'cancelled' },
    ]);
  });

  it('marks the failed review of a run halted on it, as the live rail does', () => {
    const stages = atRestRailStages(
      makeRunRecord({
        status: {
          kind: 'open',
          stop: {
            kind: 'waiting-for-you',
            on: { kind: 'halt', issue: makeRecoveryIssue({ reason: 'review-failed' }) },
          },
          resumeAt: { kind: 'review', cycle: 1 },
        },
        hydration: {
          kind: 'loaded',
          state: makeWorkflowState({
            phase: 'complete',
            reviewStatus: 'failed',
            workspace: WORKSPACE,
          }),
        },
      }),
    );
    expect(stages.map((stage) => stage.status)).toEqual(['done', 'done', 'failed', 'pending']);
  });

  it('keeps every stage done on a failed review accepted as is', () => {
    const stages = atRestRailStages(
      makeRunRecord({
        status: { kind: 'ready-to-apply', override: true },
        hydration: {
          kind: 'loaded',
          state: makeWorkflowState({
            phase: 'complete',
            reviewStatus: 'failed',
            acceptedAsIs: { at: '2026-10-06T23:11:53.230Z', findings: [] },
            workspace: WORKSPACE,
          }),
        },
      }),
    );
    expect(stages.map((stage) => stage.status)).toEqual(['done', 'done', 'done', 'pending']);
  });

  it('marks Apply with the halt of a run stopped inside it', () => {
    const stages = atRestRailStages(
      workspaceRecord({
        kind: 'open',
        stop: {
          kind: 'waiting-for-you',
          on: { kind: 'halt', issue: makeRecoveryIssue({ reason: 'apply-conflict' }) },
        },
        resumeAt: { kind: 'apply' },
      }),
    );
    expect(stages.map((stage) => stage.status)).toEqual(['done', 'done', 'done', 'failed']);
  });

  it('keeps three stages on a run without a workspace', () => {
    expect(atRestRailStages(recordAt({ status: { kind: 'closed', as: 'complete' } }))).toHaveLength(
      3,
    );
  });
});

describe('atRestComposer', () => {
  it('takes commands and the result menu on a run ready to apply; Enter does not continue it', () => {
    const composer = atRestComposer(workspaceRecord({ kind: 'ready-to-apply', override: false }));
    expect(composer).toEqual({
      continuable: false,
      commandsOnly: true,
      placeholder: '/ for a command · tab for the result menu…',
    });
  });

  it('takes a correction from a run that can be picked up', () => {
    const composer = atRestComposer(
      recordAt({
        status: openWith({ kind: 'stopped', on: { kind: 'interrupted' } }),
        phase: 'implementing',
      }),
    );
    expect(composer).toEqual({
      continuable: true,
      commandsOnly: false,
      placeholder: 'Type a correction, or ⏎ to continue…',
    });
  });

  it('takes commands only from a closed run', () => {
    const composer = atRestComposer(recordAt({ status: { kind: 'closed', as: 'complete' } }));
    expect(composer.continuable).toBe(false);
    expect(composer.commandsOnly).toBe(true);
  });

  it('takes commands only when the saved state cannot be read', () => {
    const composer = atRestComposer(
      makeRunRecord({
        status: openWith({ kind: 'stopped', on: { kind: 'failed', message: 'unreadable' } }),
      }),
    );
    expect(composer.continuable).toBe(false);
  });
});

describe('recordPhase', () => {
  it('reads the saved state first', () => {
    expect(recordPhase(recordAt({ status: { kind: 'running' }, phase: 'planning' }))).toBe(
      'planning',
    );
  });

  it('falls back to idle when nothing recorded a phase', () => {
    expect(recordPhase(makeRunRecord())).toBe('idle');
  });

  it('prefers the phase the saved state names over the summary', () => {
    expect(
      recordPhase(
        makeRunRecord({
          summary: makeSummary({ phase: 'planning', totalTasks: 4 }),
          hydration: { kind: 'loaded', state: makeWorkflowState({ phase: 'implementing' }) },
        }),
      ),
    ).toBe('implementing');
  });

  it('falls back to the summary when there is no saved state to read', () => {
    expect(recordPhase(makeRunRecord({ summary: makeSummary({ phase: 'final-review' }) }))).toBe(
      'final-review',
    );
  });

  // One phase per record, for the header rail and the closed block alike.
  it.each([
    [
      'implementing',
      'stopped inside a brief',
      makeSummary({ totalTasks: 0, stoppedAt: { taskId: taskId('T003'), partialFiles: [] } }),
    ],
    ['implementing', 'compiled briefs', makeSummary({ totalTasks: 2 })],
    ['final-review', 'only has a packet', makeSummary({ totalTasks: 0, reviewPacket: PACKET })],
    ['planning', 'carries nothing later', makeSummary({ totalTasks: 0 })],
  ] as const)('infers %s for a legacy summary that %s', (phase, _label, summary) => {
    expect(recordPhase(makeRunRecord({ summary }))).toBe(phase);
  });

  it('treats an idle saved phase as no stage and infers from the record', () => {
    const record = makeRunRecord({
      status: { kind: 'closed', as: 'ended' },
      summary: makeSummary({ totalTasks: 0 }),
      hydration: { kind: 'loaded', state: makeWorkflowState({ phase: 'idle' }) },
    });
    expect(recordPhase(record)).toBe('planning');
    expect(atRestRailStages(record)[0]).toEqual({ stage: 'plan', status: 'cancelled' });
  });

  it('stands a run whose final review failed in the review, until it is accepted as is', () => {
    const failed = makeWorkflowState({ phase: 'complete', reviewStatus: 'failed' });
    expect(recordPhase(makeRunRecord({ hydration: { kind: 'loaded', state: failed } }))).toBe(
      'final-review',
    );
    const accepted = { ...failed, acceptedAsIs: { at: '2026-10-06T23:11:53.230Z', findings: [] } };
    expect(recordPhase(makeRunRecord({ hydration: { kind: 'loaded', state: accepted } }))).toBe(
      'complete',
    );
  });
});
