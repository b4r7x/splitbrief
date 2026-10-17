import { describe, expect, it } from 'vitest';
import { makeSummary } from '#testing/helpers/factories/summary.js';
import { makeCostBreakdown } from '#testing/helpers/factories/cost-breakdown.js';
import type { EvidenceLedger, EvidenceTask } from '../../../core/schemas/evidence.js';
import type { Phase } from '../../../core/schemas/enums.js';
import type { Summary } from '../../../core/schemas/summary.js';
import type { TaskTokenUsage } from '../../../core/schemas/tokens.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { taskId } from '../../../core/schemas/task.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { hashTaskBrief } from '../../../core/evidence/brief-hash.js';
import type { RunRecord } from '../../../core/sessions/run-record.js';
import { makeRunRecord } from '#testing/helpers/factories/run-record.js';
import { makeWorkflowState } from '#testing/helpers/factories/workflow-state.js';
import { arrowSep } from '../../../core/separators.js';
import { crewLine, runRows } from './copy.js';
import { bylineParts } from './byline.js';
import { outcomeLineSpans } from './outcome.js';
import { deriveSummaryView, type SummaryView } from './view-model.js';
import { atRestRailStages } from '../at-rest.js';

function ledgerTask(overrides: Partial<EvidenceTask> & Pick<EvidenceTask, 'id'>): EvidenceTask {
  return {
    title: `title ${overrides.id}`,
    file: 'src/a.ts',
    status: 'done',
    retries: 0,
    changedFiles: [],
    expectedEvidence: [],
    observedEvidence: [],
    escalated: false,
    ...overrides,
  };
}

function makeLedger(tasks: EvidenceTask[]): EvidenceLedger {
  return {
    version: 1,
    sessionId: '2026-09-14-feature',
    feature: 'feature',
    generatedAt: '2026-09-14T00:00:00.000Z',
    tasks,
    validationSummary: { passed: 0, failed: 0, skipped: 0, escalated: 0 },
  };
}

function booked(overrides: Partial<TaskTokenUsage> & Pick<TaskTokenUsage, 'taskId'>) {
  return {
    taskTitle: `title ${overrides.taskId}`,
    method: 'local',
    implementerTokens: 0,
    escalationTokens: 0,
    retryCount: 0,
    ...overrides,
  } satisfies TaskTokenUsage;
}

function derive(
  summary: Summary,
  overrides: Partial<Omit<RunRecord, 'summary'>> = {},
): SummaryView {
  const view = deriveSummaryView({
    record: makeRunRecord({
      summary,
      ...overrides,
    }),
  });
  if (view === null) throw new Error('expected a closed run to have a view');
  return view;
}

const ENDED = { kind: 'closed', as: 'ended' } as const;

function readySummary(overrides: Partial<Summary> = {}): Summary {
  return makeSummary({
    totalTasks: 3,
    completedByLocal: 3,
    reviewPacket: {
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
    },
    ...overrides,
  });
}

describe('outcome kind', () => {
  it('is ready only when the packet, the verdict, the scope check and the briefs all agree', () => {
    expect(derive(readySummary()).outcome.kind).toBe('complete');
  });

  it.each([
    ['a failing verdict', { finalReviewVerdict: 'fail' as const }],
    ['a packet that was never written', { finalReviewStatus: 'missing' as const }],
    ['a failed scope check', { driftPassed: false }],
    ['an unknown scope result', { driftPassed: null }],
  ])('needs attention with %s', (_label, packetOverrides) => {
    const base = readySummary();
    const packet = base.reviewPacket;
    expect(packet).toBeDefined();
    if (packet === undefined) return;
    const summary = makeSummary({ ...base, reviewPacket: { ...packet, ...packetOverrides } });
    expect(derive(summary).outcome.kind).toBe('needs-attention');
  });

  it('needs attention when a brief failed even though the review passed', () => {
    expect(derive(readySummary({ failed: 1 })).outcome.kind).toBe('needs-attention');
  });

  it('reports a run somebody ended as ended, whatever its checks said', () => {
    expect(derive(readySummary(), { status: ENDED }).outcome.kind).toBe('ended');
  });

  it('has no view at all for a run that is still open', () => {
    expect(
      deriveSummaryView({
        record: makeRunRecord({
          summary: readySummary(),
          status: {
            kind: 'open',
            stop: { kind: 'stopped', on: { kind: 'interrupted' } },
            resumeAt: { kind: 'review', cycle: 0 },
          },
        }),
      }),
    ).toBeNull();
  });

  it('has no view for a closed run that left no record', () => {
    expect(deriveSummaryView({ record: makeRunRecord() })).toBeNull();
  });
});

describe('ran', () => {
  it('reads how long the run ran off its record, and null on a record that never kept it', () => {
    expect(derive(readySummary({ activeTime: 111_503 })).ran).toBe(111_503);
    expect(derive(readySummary()).ran).toBeNull();
  });
});

const WORKSPACE = {
  kind: 'worktree' as const,
  path: '/tmp/run-workspace',
  base: { snapshotId: 'workspace-base', head: null },
};

const CHANGED = ['src/validate.ts'];
const PATCH_PATH = '.splitbrief/sessions/2026-09-14-feature/run.patch';

function workspaceHydration(
  phase: Phase,
  closed?: WorkflowState['closed'],
): RunRecord['hydration'] {
  return {
    kind: 'loaded',
    state: makeWorkflowState({ phase, workspace: WORKSPACE, ...(closed && { closed }) }),
  };
}

const CLOSED_AT = '2026-09-14T10:00:00.000Z';

describe('a run with a workspace', () => {
  it.each(['worktree', 'staged-copy', 'checkout'] as const)(
    'offers Apply undo only with a backup on a %s run',
    (kind) => {
      for (const backedUp of [false, true]) {
        const view = derive(readySummary({ changedFiles: CHANGED }), {
          status: { kind: 'closed', as: 'applied' },
          hydration: {
            kind: 'loaded',
            state: makeWorkflowState({
              phase: 'complete',
              workspace: { ...WORKSPACE, kind },
              ...(backedUp
                ? { applied: { at: CLOSED_AT, backupId: 'apply-1', files: CHANGED } }
                : {}),
            }),
          },
        });
        expect(
          bylineParts(view, 120)
            .map((part) => part.text)
            .join(''),
        ).toBe(backedUp && kind !== 'checkout' ? 'Undo the Apply with /run reject confirm' : '');
      }
    },
  );

  it('reads an applied run as applied, with every stage and Apply done', () => {
    const view = derive(readySummary({ changedFiles: CHANGED }), {
      status: { kind: 'closed', as: 'applied' },
      hydration: workspaceHydration('complete'),
    });
    expect(view.outcome.kind).toBe('applied');
    expect(view.rail.map((state) => state.status)).toEqual(['done', 'done', 'done', 'done']);
    expect(view.files.patch).toBeNull();
  });

  it('names the reviewer checks the review record saw red at the run base too', () => {
    const state = makeWorkflowState({ phase: 'complete', workspace: WORKSPACE });
    const keys = ['a.test.ts > one', 'a.test.ts > two', 'a.test.ts > three', 'a.test.ts > four'];
    const view = derive(readySummary({ changedFiles: CHANGED }), {
      status: { kind: 'closed', as: 'applied' },
      hydration: {
        kind: 'loaded',
        state: {
          ...state,
          review: {
            scope: 'final',
            cycle: 0,
            verdict: { tasks: [], criteria: [], findings: [] },
            outcome: 'pass',
            verification: [],
            preExistingChecks: [{ id: 'V1', command: 'npm test', keys }],
            at: CLOSED_AT,
          },
        },
      },
    });

    expect(view.review).toMatchObject({
      kind: 'written',
      preExisting: [
        {
          id: 'V1',
          command: 'npm test',
          tests: ['a.test.ts > one', 'a.test.ts > two', 'a.test.ts > three', '+1 more'],
        },
      ],
    });
    expect(
      derive(readySummary(), { hydration: workspaceHydration('complete') }).review,
    ).toMatchObject({ preExisting: [] });
  });

  // `/run reject confirm` on a run whose Apply was already undone refuses (`canUndoApply`):
  // the closed block of that run says the undo happened and offers it no second time.
  it('reads an applied run whose Apply was undone as undone, offering no second undo', () => {
    const view = derive(readySummary({ changedFiles: CHANGED }), {
      status: { kind: 'closed', as: 'applied' },
      hydration: {
        kind: 'loaded',
        state: makeWorkflowState({
          phase: 'complete',
          workspace: WORKSPACE,
          applied: {
            at: CLOSED_AT,
            backupId: 'apply-1',
            files: CHANGED,
            undone: { at: CLOSED_AT, conflicts: [] },
          },
        }),
      },
    });
    const byline = bylineParts(view, 120)
      .map((part) => part.text)
      .join('');
    expect(byline).not.toContain('/run reject');
    expect(byline.toLowerCase()).toContain('undone');
  });

  it('names undo conflicts on the Apply row and marks the reverted Apply on the rail', () => {
    const view = derive(readySummary({ changedFiles: CHANGED }), {
      status: { kind: 'closed', as: 'applied' },
      hydration: {
        kind: 'loaded',
        state: makeWorkflowState({
          phase: 'complete',
          workspace: WORKSPACE,
          applied: {
            at: CLOSED_AT,
            backupId: 'apply-1',
            files: CHANGED,
            undone: { at: CLOSED_AT, conflicts: ['src/later-edit.ts'] },
          },
        }),
      },
    });
    const row = runRows(view).find((row) => row.label === 'Apply');
    expect(row).toBeDefined();
    if (row === undefined) throw new Error('Missing Apply row');
    expect(row.segments).toEqual([
      {
        spans: [
          { text: 'undone', tone: 'warning' },
          { text: ', 1 conflict kept', tone: 'textDim' },
        ],
      },
    ]);
    expect(view.rail.find((stage) => stage.stage === 'apply')?.status).toBe('cancelled');
    expect(
      bylineParts(view, 120)
        .map((part) => part.text)
        .join(''),
    ).not.toContain('/run reject');
  });

  it('reads a discarded run as discarded, its changes saved in run.patch', () => {
    const view = derive(readySummary({ changedFiles: CHANGED }), {
      status: { kind: 'closed', as: 'discarded' },
      hydration: workspaceHydration('complete', {
        at: CLOSED_AT,
        as: 'discarded',
        patch: PATCH_PATH,
      }),
    });
    expect(view.outcome.kind).toBe('discarded');
    expect(view.rail.map((state) => state.status)).toEqual(['done', 'done', 'done', 'cancelled']);
    expect(view.files.patch).toBe(PATCH_PATH);
  });

  it('says an ended run left its changes in run.patch', () => {
    const view = derive(makeSummary({ phase: 'implementing', changedFiles: CHANGED }), {
      status: ENDED,
      hydration: workspaceHydration('implementing', {
        at: CLOSED_AT,
        as: 'ended',
        patch: PATCH_PATH,
      }),
    });
    expect(view.outcome.kind).toBe('ended');
    expect(view.files.patch).toBe(PATCH_PATH);
    expect(view.rail.map((state) => state.status)).toEqual(['done', 'cancelled', 'pending']);
  });

  // In a real run, `× Ended · Apply 12/12 · changes saved in run.patch` under a rail whose failed
  // review read done. The closed block and the header rail read one rail.
  it('stops a run ended on a failed review at Review, on the rail the header paints', () => {
    const passed = readySummary();
    const record = makeRunRecord({
      summary: {
        ...passed,
        changedFiles: CHANGED,
        ...(passed.reviewPacket && {
          reviewPacket: {
            ...passed.reviewPacket,
            finalReviewVerdict: 'fail',
            finalReviewFindingCounts: { critical: 0, warning: 0, note: 7 },
          },
        }),
      },
      status: ENDED,
      hydration: {
        kind: 'loaded',
        state: makeWorkflowState({
          phase: 'complete',
          reviewStatus: 'failed',
          workspace: WORKSPACE,
          closed: { at: CLOSED_AT, as: 'ended', patch: PATCH_PATH },
        }),
      },
    });
    const view = deriveSummaryView({ record });
    if (view === null) throw new Error('expected a closed run to have a view');
    expect(view.rail).toEqual([
      { stage: 'plan', status: 'done' },
      { stage: 'build', status: 'done' },
      { stage: 'review', status: 'cancelled' },
    ]);
    expect(view.rail).toEqual(atRestRailStages(record));
    expect(
      outcomeLineSpans(view, 120)
        .map((span) => span.text)
        .join(''),
    ).toBe('Ended · Review 3/3 · changes saved in run.patch');
  });

  it('names no patch the close did not record', () => {
    const view = derive(makeSummary({ phase: 'implementing', changedFiles: CHANGED }), {
      status: ENDED,
      hydration: workspaceHydration('implementing', { at: CLOSED_AT, as: 'ended' }),
    });
    expect(view.files.patch).toBeNull();
  });

  it('writes no patch for a run without a workspace', () => {
    expect(
      derive(makeSummary({ phase: 'implementing', changedFiles: CHANGED }), { status: ENDED }).files
        .patch,
    ).toBeNull();
  });

  it('names no patch for a discarded run that changed no file', () => {
    const view = derive(readySummary({ changedFiles: [] }), {
      status: { kind: 'closed', as: 'discarded' },
      hydration: workspaceHydration('complete', {
        at: CLOSED_AT,
        as: 'discarded',
        patch: PATCH_PATH,
      }),
    });
    expect(view.files.patch).toBeNull();
  });
});

describe('rail', () => {
  it('marks all three stages done on a finished run', () => {
    const rail = derive(readySummary()).rail;
    expect(rail).toEqual([
      { stage: 'plan', status: 'done' },
      { stage: 'build', status: 'done' },
      { stage: 'review', status: 'done' },
    ]);
  });

  it('freezes an ended run at the stage it stopped in', () => {
    const view = derive(makeSummary({ phase: 'planning' }), { status: ENDED });
    expect(view.rail.map((state) => state.status)).toEqual(['cancelled', 'pending', 'pending']);
  });

  it('marks the stage an ended run stopped in', () => {
    const view = derive(makeSummary({ phase: 'implementing' }), { status: ENDED });
    expect(view.rail[1]).toEqual({ stage: 'build', status: 'cancelled' });
  });

  it('folds an ended old run stopped in research into Plan', () => {
    const view = derive(makeSummary({ phase: 'researching' }), {
      status: ENDED,
      ledger: makeLedger([ledgerTask({ id: taskId('T001'), status: 'pending' })]),
    });
    expect(view.rail).toEqual([
      { stage: 'plan', status: 'cancelled' },
      { stage: 'build', status: 'pending' },
      { stage: 'review', status: 'pending' },
    ]);
  });
});

describe('seats', () => {
  it('names a seat with its tool and model', () => {
    const view = derive(
      makeSummary({ plannerTool: 'claude-code', plannerModel: 'claude-sonnet-4' }),
    );
    expect(view.seats.plan).toEqual({
      kind: 'named',
      short: 'Sonnet 4',
    });
  });

  it('names each seat and the crew line in the words the live rail uses', () => {
    const view = derive(
      makeSummary({
        plannerTool: 'claude-code',
        plannerModel: 'opus',
        implementerTool: 'claude-code',
        implementerModel: 'sonnet',
      }),
    );
    expect(view.seats.plan).toEqual({
      kind: 'named',
      short: 'Opus 5.5',
    });
    expect(view.seats.build).toEqual({
      kind: 'named',
      short: 'Sonnet 5.5',
    });
    const spans = crewLine(view, 200);
    expect(spans.map((span) => span.text).join('')).toBe(
      'PLAN Opus 5.5 · BUILD Sonnet 5.5 · REVIEW = PLAN',
    );
    expect(spans.map((span) => span.seat)).toEqual([
      'plan',
      undefined,
      'build',
      undefined,
      'review',
    ]);
  });

  it('shortens each seat with the formatter the live rail uses', () => {
    const view = derive(
      makeSummary({
        plannerTool: 'codex',
        implementerTool: 'cursor',
        implementerModel: 'gpt-5.3-codex-high',
      }),
    );
    expect(
      crewLine(view, 200)
        .map((span) => span.text)
        .join(''),
    ).toBe('PLAN auto · BUILD GPT-5.3 Codex · REVIEW = PLAN');
  });

  it('says the build seat moved, from what to what, when each tool ran one stretch', () => {
    const on = (input: { id: string; tool: string; model: string }) =>
      booked({
        taskId: taskId(input.id),
        implementerProfile: 'default',
        tool: input.tool,
        model: input.model,
      });
    const view = derive(
      makeSummary({
        implementerTool: 'opencode',
        implementerModel: 'opencode-go/deepseek-v4.1-flash',
        taskBreakdown: [
          on({ id: 'T001', tool: 'antigravity', model: 'gemini-3.8-flash-high' }),
          on({ id: 'T002', tool: 'antigravity', model: 'gemini-3.8-flash-high' }),
          on({ id: 'T003', tool: 'opencode', model: 'opencode-go/deepseek-v4.1-flash' }),
        ],
      }),
    );
    expect(
      crewLine(view, 200)
        .map((span) => span.text)
        .join(''),
    ).toBe(
      `PLAN not recorded · BUILD Gemini 3.8 Flash${arrowSep()}DeepSeek V4.1 Flash via opencode-go · REVIEW not recorded`,
    );
  });

  it('counts the briefs on each tool when the seat went back and forth', () => {
    const on = (input: { id: string; tool: string; model: string }) =>
      booked({
        taskId: taskId(input.id),
        implementerProfile: 'default',
        tool: input.tool,
        model: input.model,
      });
    const view = derive(
      makeSummary({
        implementerTool: 'opencode',
        implementerModel: 'opencode-go/deepseek-v4.1-flash',
        taskBreakdown: [
          on({ id: 'T001', tool: 'antigravity', model: 'gemini-3.8-flash-high' }),
          on({ id: 'T002', tool: 'opencode', model: 'opencode-go/deepseek-v4.1-flash' }),
          on({ id: 'T003', tool: 'antigravity', model: 'gemini-3.8-flash-high' }),
          on({ id: 'T004', tool: 'antigravity', model: 'gemini-3.8-flash-high' }),
        ],
      }),
    );
    expect(
      crewLine(view, 200)
        .map((span) => span.text)
        .join(''),
    ).toContain('BUILD 3 briefs on Gemini 3.8 Flash, 1 on DeepSeek V4.1 Flash via opencode-go');
  });

  it('marks the review seat as inherited when only the planner was named', () => {
    const view = derive(makeSummary({ plannerTool: 'claude-code' }));
    expect(view.seats.review).toEqual({ kind: 'inherits' });
  });

  it('leaves every seat unset when the run recorded no tools', () => {
    const view = derive(makeSummary());
    expect(view.seats).toEqual({
      plan: { kind: 'unset' },
      build: { kind: 'unset' },
      review: { kind: 'unset' },
    });
  });

  it('names the profiles when briefs went to more than one implementer', () => {
    const view = derive(
      makeSummary({
        implementerTool: 'opencode',
        taskBreakdown: [
          booked({ taskId: taskId('T001'), implementerProfile: 'quick', tool: 'opencode' }),
          booked({ taskId: taskId('T002'), implementerProfile: 'careful', tool: 'codex' }),
        ],
      }),
    );
    expect(view.seats.build).toEqual({ kind: 'mixed', profiles: ['careful', 'quick'] });
  });

  it('keeps one build seat when every brief went to the same implementer', () => {
    const view = derive(
      makeSummary({
        implementerTool: 'opencode',
        implementerModel: 'qwen2.5-coder:7b',
        taskBreakdown: [
          booked({ taskId: taskId('T001'), tool: 'opencode', model: 'qwen2.5-coder:7b' }),
          booked({ taskId: taskId('T002'), tool: 'opencode', model: 'qwen2.5-coder:7b' }),
        ],
      }),
    );
    expect(view.seats.build.kind).toBe('named');
  });

  it('spells a recorded API seat model pretty when the cost record kept its kind', () => {
    const view = derive(
      makeSummary({
        plannerTool: 'opencode',
        plannerModel: 'gpt-5',
        costBreakdown: makeCostBreakdown({
          providerRunMetadata: {
            'api:opencode': {
              service: 'opencode',
              offering: 'payg',
              normalizedEndpoint: 'https://my-endpoint.example/v1',
              billing: 'api-metered',
              asOf: '',
            },
          },
        }),
      }),
    );

    expect(view.seats.plan).toEqual({
      kind: 'named',
      short: 'GPT-5',
    });
  });

  it('spells a recorded API seat model pretty when its name is a CLI alias, never with the CLI alias name', () => {
    const view = derive(
      makeSummary({
        plannerTool: 'claude-code',
        plannerModel: 'sonnet',
        costBreakdown: makeCostBreakdown({
          providerRunMetadata: {
            'api:claude-code': {
              service: 'claude-code',
              offering: 'payg',
              normalizedEndpoint: 'https://my-endpoint.example/v1',
              billing: 'api-metered',
              asOf: '',
            },
          },
        }),
      }),
    );

    // The API twin must not borrow the CLI alias's display name for its own model.
    expect(view.seats.plan).toEqual({
      kind: 'named',
      short: 'Sonnet',
    });
  });

  it('reads a legacy name-only record through the merged catalog as before', () => {
    const view = derive(
      makeSummary({
        plannerTool: 'claude-code',
        plannerModel: 'sonnet',
        costBreakdown: makeCostBreakdown({
          providerRunMetadata: {
            'claude-code': {
              service: 'claude-code',
              offering: 'payg',
              normalizedEndpoint: 'cli:claude-code',
              billing: 'provider-dependent',
              asOf: '',
            },
          },
        }),
      }),
    );

    expect(view.seats.plan).toEqual({
      kind: 'named',
      short: 'Sonnet 5.5',
    });
  });

  it('leaves a recorded name the run used under two kinds on the name-only words', () => {
    const view = derive(
      makeSummary({
        plannerTool: 'claude-code',
        plannerModel: 'sonnet',
        costBreakdown: makeCostBreakdown({
          providerRunMetadata: {
            'api:claude-code': {
              service: 'claude-code',
              offering: 'payg',
              normalizedEndpoint: 'https://my-endpoint.example/v1',
              billing: 'api-metered',
              asOf: '',
            },
            'cli:claude-code': {
              service: 'claude-code',
              offering: 'payg',
              normalizedEndpoint: 'cli:claude-code',
              billing: 'provider-dependent',
              asOf: '',
            },
          },
        }),
      }),
    );

    // The API kind alone reads `Sonnet`; an ambiguous name reads the merged catalog's alias.
    expect(view.seats.plan).toEqual({ kind: 'named', short: 'Sonnet 5.5' });
  });

  it('names a moved API seat literally when its name is a CLI tool id', () => {
    const on = (input: { id: string; tool: string; model: string }) =>
      booked({
        taskId: taskId(input.id),
        implementerProfile: 'default',
        tool: input.tool,
        model: input.model,
      });
    const view = derive(
      makeSummary({
        implementerTool: 'opencode',
        costBreakdown: makeCostBreakdown({
          providerRunMetadata: {
            'api:opencode': {
              service: 'opencode',
              offering: 'payg',
              normalizedEndpoint: 'https://my-endpoint.example/v1',
              billing: 'api-metered',
              asOf: '',
            },
            'cli:codex': {
              service: 'codex',
              offering: 'payg',
              normalizedEndpoint: 'cli:codex',
              billing: 'subscription-included',
              asOf: '',
            },
          },
        }),
        taskBreakdown: [
          on({ id: 'T001', tool: 'opencode', model: 'auto' }),
          on({ id: 'T002', tool: 'codex', model: 'auto' }),
        ],
      }),
    );

    // Both short forms are `auto`, so each moved seat is named with its tool.
    expect(view.seats.build).toEqual({
      kind: 'moved',
      seats: [
        { short: 'opencode auto', briefs: 1 },
        { short: 'OpenAI Codex CLI auto', briefs: 1 },
      ],
      contiguous: true,
    });
  });
});

describe('brief rows', () => {
  it.each(['', 'src/current.ts'])(
    'keeps the recorded file when the plan target is empty (%s)',
    (file) => {
      const task = makeTask({ title: 'Update report', status: 'done', suggestedFiles: [file] });
      const view = derive(makeSummary({ totalTasks: 1, completedByLocal: 1 }), {
        hydration: {
          kind: 'loaded',
          state: makeWorkflowState({ phase: 'complete', tasks: [task] }),
        },
        ledger: makeLedger([
          ledgerTask({
            id: task.id,
            title: task.title,
            file: 'src/recorded.ts',
            briefHash: hashTaskBrief([task]),
          }),
        ]),
      });
      expect(view.briefs.rows[0]?.file).toBe(file === '' ? 'src/recorded.ts' : file);
      expect(view.briefs.earlierRows).toEqual([]);
    },
  );

  it('names a done brief the consult seat completed as consulted, with its retry', () => {
    const task = makeTask({ id: 'T001', title: 'Add clamp', status: 'done' });
    const view = derive(
      makeSummary({
        totalTasks: 1,
        completedByLocal: 1,
        taskBreakdown: [booked({ taskId: taskId('T001'), method: 'consulted', retryCount: 1 })],
      }),
      {
        status: ENDED,
        hydration: {
          kind: 'loaded',
          state: makeWorkflowState({ phase: 'complete', tasks: [task] }),
        },
        ledger: makeLedger([
          ledgerTask({
            id: task.id,
            title: task.title,
            method: 'consulted',
            retries: 1,
            briefHash: hashTaskBrief([task]),
          }),
        ]),
      },
    );
    expect(view.briefs.rows[0]).toMatchObject({ state: 'local', method: 'consulted', retries: 1 });
  });

  it('lists all current briefs when a run ends at its plan gate before the first evidence write', () => {
    const tasks = [
      makeTask({ id: 'T001', title: 'First brief' }),
      makeTask({ id: 'T002', title: 'Second brief' }),
      makeTask({ id: 'T003', title: 'Third brief' }),
    ];
    const view = derive(makeSummary({ totalTasks: 3, changedFiles: [] }), {
      status: ENDED,
      hydration: { kind: 'loaded', state: makeWorkflowState({ phase: 'reviewing-plan', tasks }) },
    });
    expect(view.briefs.rows.map((row) => [row.id, row.title, row.state])).toEqual([
      ['T001', 'First brief', 'pending'],
      ['T002', 'Second brief', 'pending'],
      ['T003', 'Third brief', 'pending'],
    ]);
    expect(view.briefs.earlierRows).toEqual([]);
  });

  it('keeps old ledger work separate from a newly defined T001 after a rewind', () => {
    const old = ledgerTask({
      id: taskId('T001'),
      title: 'Old brief',
      file: 'src/old.ts',
      changedFiles: ['src/old.ts'],
    });
    const state = makeWorkflowState({
      phase: 'reviewing-plan',
      tasks: [makeTask({ id: 'T001', title: 'New brief', suggestedFiles: ['src/new.ts'] })],
    });
    const view = derive(
      makeSummary({
        totalTasks: 1,
        completedByLocal: 0,
        changedFiles: ['src/old.ts'],
        taskBreakdown: [booked({ taskId: taskId('T001'), taskTitle: 'Old brief' })],
      }),
      { status: ENDED, hydration: { kind: 'loaded', state }, ledger: makeLedger([old]) },
    );
    expect(view.briefs.rows.map((row) => [row.id, row.title, row.state])).toEqual([
      ['T001', 'New brief', 'pending'],
    ]);
    expect(view.briefs.earlierRows.map((row) => [row.id, row.title, row.state])).toEqual([
      ['T001', 'Old brief', 'local'],
    ]);
    expect(view.files.changed).toEqual(['src/old.ts']);
    expect(view.files.stoppedAt).toBeNull();
  });

  it('follows the ledger plan order and joins the spend record by id', () => {
    const view = derive(
      makeSummary({
        totalTasks: 3,
        taskBreakdown: [
          booked({ taskId: taskId('T002'), method: 'escalated-full', retryCount: 2 }),
        ],
      }),
      {
        ledger: makeLedger([
          ledgerTask({ id: taskId('T001'), durationMs: 84_200 }),
          ledgerTask({ id: taskId('T002'), status: 'escalated', escalated: true, retries: 2 }),
          ledgerTask({ id: taskId('T003'), status: 'pending' }),
        ]),
      },
    );
    expect(view.briefs.rows.map((row) => row.id)).toEqual(['T001', 'T002', 'T003']);
    expect(view.briefs.rows[0]).toMatchObject({ state: 'local', durationMs: 84_200 });
    expect(view.briefs.rows[1]).toMatchObject({ state: 'escalated', retries: 2 });
    expect(view.briefs.rows[2]).toMatchObject({ state: 'pending', durationMs: null });
  });

  it('marks the brief the run stopped in and counts its partial files', () => {
    const view = derive(
      makeSummary({
        totalTasks: 2,
        stoppedAt: { taskId: taskId('T002'), partialFiles: ['src/a.ts', 'src/b.ts'] },
      }),
      {
        status: ENDED,
        ledger: makeLedger([
          ledgerTask({ id: taskId('T001') }),
          ledgerTask({ id: taskId('T002'), status: 'in_progress' }),
        ]),
      },
    );
    expect(view.briefs.rows[1]).toMatchObject({ state: 'stopped', partialFiles: 2 });
    expect(view.briefs.rows[0]?.partialFiles).toBe(0);
  });

  // In a real run, End run on a consult-bound halt. The saved brief was still in progress, its
  // ledger entry read failed: `Briefs ─` said T005 stopped with no file or duration, and
  // `Earlier work ─` said T005 failed. One brief, one row, one status word.
  it('joins the failed attempt the ledger booked to the brief the run stopped in', () => {
    const first = makeTask({
      id: 'T001',
      title: 'First brief',
      suggestedFiles: ['src/a.ts'],
      status: 'done',
    });
    const second = makeTask({
      id: 'T002',
      title: 'Second brief',
      suggestedFiles: ['src/b.ts'],
      status: 'in_progress',
    });
    const tasks = [first, second];
    const view = derive(
      makeSummary({
        totalTasks: 2,
        completedByLocal: 1,
        changedFiles: ['src/a.ts', 'src/b.ts'],
        stoppedAt: { taskId: taskId('T002'), partialFiles: ['src/b.ts'] },
      }),
      {
        status: ENDED,
        hydration: {
          kind: 'loaded',
          state: makeWorkflowState({ phase: 'implementing', tasks, currentTaskIndex: 1 }),
        },
        ledger: makeLedger([
          ledgerTask({
            id: taskId('T001'),
            title: 'First brief',
            file: 'src/a.ts',
            durationMs: 666_711,
            changedFiles: ['src/a.ts'],
            briefHash: hashTaskBrief([first]),
          }),
          ledgerTask({
            id: taskId('T002'),
            title: 'Second brief',
            file: 'src/b.ts',
            status: 'failed',
            retries: 3,
            durationMs: 3_236_892,
            changedFiles: ['src/b.ts'],
            briefHash: hashTaskBrief([second]),
          }),
        ]),
      },
    );
    expect(view.briefs.rows.map((row) => [row.id, row.state, row.file, row.durationMs])).toEqual([
      ['T001', 'local', 'src/a.ts', 666_711],
      ['T002', 'stopped', 'src/b.ts', 3_236_892],
    ]);
    expect(view.briefs.earlierRows).toEqual([]);
    expect([...view.files.partial]).toEqual(['src/b.ts']);
  });

  // In a real run, End run during the BUILD call of T003: the ledger still held the pending seed
  // of T003, so `Briefs ─` said T003 stopped and `Earlier work ─` listed T003 a second time.
  it('joins the pending seed of a brief the run stopped in before the ledger booked it', () => {
    const first = makeTask({ id: 'T001', title: 'First', suggestedFiles: ['src/a.ts'] });
    const second = makeTask({ id: 'T002', title: 'Second', suggestedFiles: ['src/b.ts'] });
    const tasks = [
      { ...first, status: 'done' as const },
      { ...second, status: 'in_progress' as const },
    ];
    const view = derive(
      makeSummary({
        totalTasks: 2,
        completedByLocal: 1,
        changedFiles: ['src/a.ts'],
        stoppedAt: { taskId: taskId('T002'), partialFiles: [] },
      }),
      {
        status: ENDED,
        hydration: {
          kind: 'loaded',
          state: makeWorkflowState({ phase: 'implementing', tasks, currentTaskIndex: 1 }),
        },
        ledger: makeLedger([
          ledgerTask({
            id: taskId('T001'),
            title: 'First',
            changedFiles: ['src/a.ts'],
            briefHash: hashTaskBrief([first]),
          }),
          ledgerTask({
            id: taskId('T002'),
            title: 'Second',
            file: 'src/b.ts',
            status: 'pending',
            briefHash: null,
          }),
        ]),
      },
    );
    expect(view.briefs.rows.map((row) => [row.id, row.state])).toEqual([
      ['T001', 'local'],
      ['T002', 'stopped'],
    ]);
    expect(view.briefs.earlierRows).toEqual([]);
  });

  it.each([
    ['failed', 'failed'],
    ['skipped', 'skipped'],
  ] as const)('reads a %s ledger status as %s', (status, expected) => {
    const view = derive(makeSummary({ totalTasks: 1 }), {
      ledger: makeLedger([ledgerTask({ id: taskId('T001'), status })]),
    });
    expect(view.briefs.rows[0]?.state).toBe(expected);
  });

  it('keeps a brief the ledger never saw', () => {
    const view = derive(
      makeSummary({ totalTasks: 1, taskBreakdown: [booked({ taskId: taskId('T009') })] }),
      { ledger: makeLedger([]) },
    );
    expect(view.briefs.rows.map((row) => row.id)).toEqual(['T009']);
  });

  it('counts only briefs that passed locally, never escalated ones', () => {
    const view = derive(
      makeSummary({ totalTasks: 5, completedByLocal: 1, escalatedToPlanner: 1, failed: 1 }),
    );
    expect(view.briefs).toMatchObject({ total: 5, passed: 1, failed: 1 });
  });
});

describe('review', () => {
  it('prefers the packet over the legacy review record', () => {
    const view = derive(
      readySummary({ review: { verdict: 'fail', critical: 9, warnings: 9, notes: 9 } }),
    );
    expect(view.review).toMatchObject({
      kind: 'written',
      verdict: 'pass_with_notes',
      counts: { critical: 0, warning: 1, note: 0 },
    });
  });

  it('falls back to the legacy review record when no packet was written', () => {
    const view = derive(
      makeSummary({
        totalTasks: 3,
        review: { verdict: 'pass', critical: 0, warnings: 2, notes: 1 },
        driftSummary: { passed: true, errorCount: 0, warningCount: 0 },
      }),
    );
    expect(view.review).toMatchObject({
      kind: 'written',
      verdict: 'pass',
      counts: { critical: 0, warning: 2, note: 1 },
      markdownPath: '',
    });
  });

  it('is not run when the record carries no review at all', () => {
    expect(derive(makeSummary()).review).toEqual({ kind: 'not-run' });
  });

  it.each(['failed', 'missing', 'skipped'] as const)(
    'reports a %s packet as its status',
    (kind) => {
      const base = readySummary();
      const packet = base.reviewPacket;
      if (packet === undefined) throw new Error('fixture must carry a packet');
      const view = derive(
        makeSummary({ ...base, reviewPacket: { ...packet, finalReviewStatus: kind } }),
      );
      expect(view.review).toEqual({ kind });
    },
  );
});

describe('scope', () => {
  it('is not run when the record has no drift summary', () => {
    expect(derive(makeSummary()).scope).toEqual({ kind: 'not-run' });
  });

  it('carries the deviation counts', () => {
    const view = derive(
      makeSummary({ driftSummary: { passed: false, errorCount: 1, warningCount: 1 } }),
    );
    expect(view.scope).toEqual({
      kind: 'checked',
      passed: false,
      errors: 1,
      warnings: 1,
    });
  });
});

describe('files', () => {
  it('sorts and de-duplicates the changed set and marks the partial ones', () => {
    const view = derive(
      makeSummary({
        changedFiles: ['src/b.ts', 'src/a.ts', 'src/b.ts'],
        stoppedAt: { taskId: taskId('T002'), partialFiles: ['src/b.ts'] },
      }),
    );
    expect(view.files.changed).toEqual(['src/a.ts', 'src/b.ts']);
    expect([...view.files.partial]).toEqual(['src/b.ts']);
    expect(view.files.stoppedAt).toEqual({ taskId: taskId('T002') });
  });

  it('keeps a legacy summary without a changed set distinct from an empty one', () => {
    expect(derive(makeSummary()).files.changed).toBeNull();
    expect(derive(makeSummary({ changedFiles: [] })).files.changed).toEqual([]);
  });
});

describe('checkpoint, phases and pass-through', () => {
  it('reports the run-level checkpoint decision the record carries', () => {
    expect(derive(makeSummary(), { checkpoint: { kind: 'accepted' } }).checkpoint).toEqual({
      kind: 'accepted',
    });
    expect(derive(makeSummary(), { checkpoint: { kind: 'rejected' } }).checkpoint).toEqual({
      kind: 'rejected',
    });
    expect(derive(makeSummary()).checkpoint).toBeNull();
  });

  it('reads only the three phase keys the orchestrator writes, in pipeline order', () => {
    const view = derive(
      makeSummary({
        phaseTimings: { review: 65_000, planning: 182_000, implementing: 399_000, warmup: 5 },
      }),
    );
    expect(view.phases).toEqual([
      { phase: 'planning', ms: 182_000 },
      { phase: 'implementing', ms: 399_000 },
      { phase: 'review', ms: 65_000 },
    ]);
  });

  it('drops a phase that booked no time', () => {
    const view = derive(makeSummary({ phaseTimings: { planning: 1000, implementing: 0 } }));
    expect(view.phases).toEqual([{ phase: 'planning', ms: 1000 }]);
  });

  it('carries the session id from the record, and no mode', () => {
    const view = derive(makeSummary({ mode: 'standard' }), {
      ref: { projectDir: '/tmp/p', sessionId: '2026-09-14-add-email-validation' },
    });
    expect(view.run).toEqual({
      feature: expect.any(String),
      sessionId: '2026-09-14-add-email-validation',
    });
  });

  it('strips control bytes out of every persisted string it shows', () => {
    const view = derive(
      makeSummary({
        feature: 'add \u001b[31mvalidation\u001b[0m',
        changedFiles: ['src/\u0007a.ts'],
        totalTasks: 1,
      }),
      { ledger: makeLedger([ledgerTask({ id: taskId('T001'), title: 'wire \u0000it up' })]) },
    );
    expect(view.run.feature).toBe('add validation');
    expect(view.files.changed).toEqual(['src/a.ts']);
    expect(view.briefs.rows[0]?.title).toBe('wire it up');
  });
});
