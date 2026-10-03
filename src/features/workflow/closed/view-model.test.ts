import { describe, expect, it } from 'vitest';
import { makeSummary, makeUsage } from '#testing/helpers/factories/summary.js';
import { makeCostBreakdown } from '#testing/helpers/factories/cost-breakdown.js';
import type { EvidenceLedger, EvidenceTask } from '../../../core/schemas/evidence.js';
import type { Phase } from '../../../core/schemas/enums.js';
import type { RequestEstimate, Summary } from '../../../core/schemas/summary.js';
import type { TaskTokenUsage } from '../../../core/schemas/tokens.js';
import { taskId } from '../../../core/schemas/task.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import type { RunRecord } from '../../../core/sessions/run-record.js';
import { makeRunRecord } from '#testing/helpers/factories/run-record.js';
import { makeWorkflowState } from '#testing/helpers/factories/workflow-state.js';
import { arrowSep } from '../../../core/separators.js';
import { crewLine } from './copy.js';
import { deriveSummaryView, type SummaryView } from './view-model.js';

function ledgerTask(overrides: Partial<EvidenceTask> & Pick<EvidenceTask, 'id'>): EvidenceTask {
  return {
    title: `title ${overrides.id}`,
    file: 'src/a.ts',
    status: 'done',
    retries: 0,
    changedFiles: [],
    validation: [],
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

interface DeriveOverrides extends Partial<Omit<RunRecord, 'summary'>> {
  /** The phase the saved state names; a record with none has no readable state. */
  savedPhase?: Phase;
  showSpend?: boolean;
}

function derive(summary: Summary, overrides: DeriveOverrides = {}): SummaryView {
  const { savedPhase, showSpend, ...record } = overrides;
  const view = deriveSummaryView({
    record: makeRunRecord({
      summary,
      ...(savedPhase !== undefined && {
        hydration: { kind: 'loaded', state: makeWorkflowState({ phase: savedPhase }) },
      }),
      ...record,
    }),
    ...(showSpend !== undefined && { showSpend }),
  });
  if (view === null) throw new Error('expected a closed run to have a view');
  return view;
}

const ENDED = { kind: 'closed', as: 'ended' } as const;

function unmeteredEstimate(items: RequestEstimate['items']): RequestEstimate {
  return {
    amount: null,
    currency: 'USD',
    basis: 'unavailable',
    completeness: 'unavailable',
    knownSubtotal: 0,
    reasons: ['unpriced-model'],
    items,
  };
}

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
    expect(derive(readySummary()).outcome.kind).toBe('ready');
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
            stop: { kind: 'interrupted' },
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

describe('phase resolution', () => {
  it('prefers the phase the saved state names', () => {
    const summary = makeSummary({ phase: 'planning', totalTasks: 4 });
    expect(derive(summary, { savedPhase: 'implementing' }).run.phase).toBe('implementing');
  });

  it('falls back to the summary when there is no saved state to read', () => {
    expect(derive(makeSummary({ phase: 'final-review' })).run.phase).toBe('final-review');
  });

  it('infers implementing for a legacy summary that stopped inside a brief', () => {
    const summary = makeSummary({
      totalTasks: 0,
      stoppedAt: { taskId: taskId('T003'), partialFiles: [] },
    });
    expect(derive(summary).run.phase).toBe('implementing');
  });

  it('infers implementing for a legacy summary that compiled briefs', () => {
    expect(derive(makeSummary({ totalTasks: 2 })).run.phase).toBe('implementing');
  });

  it('infers final-review for a legacy summary that only has a packet', () => {
    expect(derive(readySummary({ totalTasks: 0 })).run.phase).toBe('final-review');
  });

  it('infers planning when a legacy summary carries nothing later', () => {
    expect(derive(makeSummary({ totalTasks: 0 })).run.phase).toBe('planning');
  });

  it('treats an idle saved phase as no stage and infers from the record', () => {
    const view = derive(makeSummary({ totalTasks: 0 }), { savedPhase: 'idle', status: ENDED });
    expect(view.run.phase).toBe('planning');
    expect(view.rail.find((state) => state.status === 'cancelled')?.stage).toBe('plan');
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
      identity: 'Claude Code CLI · Claude Sonnet 4',
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
      identity: 'Claude Code CLI · Opus 5.5',
      short: 'Opus 5.5',
    });
    expect(view.seats.build).toEqual({
      kind: 'named',
      identity: 'Claude Code CLI · Sonnet 5',
      short: 'Sonnet 5',
    });
    expect(crewLine(view, 200)).toBe('PLAN Opus 5.5 · BUILD Sonnet 5 · REVIEW = PLAN');
  });

  it('shortens each seat with the formatter the live rail uses', () => {
    const view = derive(
      makeSummary({
        plannerTool: 'codex',
        implementerTool: 'cursor',
        implementerModel: 'gpt-5.3-codex-high',
      }),
    );
    expect(crewLine(view, 200)).toBe('PLAN auto · BUILD GPT-5.3 Codex · REVIEW = PLAN');
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
    expect(crewLine(view, 200)).toBe(
      `PLAN not recorded · BUILD Gemini 3.8 Flash High${arrowSep()}DeepSeek V4.1 Flash · REVIEW not recorded`,
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
    expect(crewLine(view, 200)).toContain(
      'BUILD 3 briefs on Gemini 3.8 Flash High, 1 on DeepSeek V4.1 Flash',
    );
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

  it('names a recorded API seat by its provider word and the pretty model name when the cost record kept its kind', () => {
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
      identity: 'opencode · GPT-5',
      short: 'GPT-5',
    });
  });

  it('spells a recorded API seat model pretty when its name is a CLI alias, never with the CLI label', () => {
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
      identity: 'claude-code · Sonnet',
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
      identity: 'Claude Code CLI · Sonnet 5',
      short: 'Sonnet 5',
    });
  });

  it('leaves a recorded name the run used under two kinds on the name-only words', () => {
    const view = derive(
      makeSummary({
        plannerTool: 'opencode',
        costBreakdown: makeCostBreakdown({
          providerRunMetadata: {
            'api:opencode': {
              service: 'opencode',
              offering: 'payg',
              normalizedEndpoint: 'https://my-endpoint.example/v1',
              billing: 'api-metered',
              asOf: '',
            },
            'cli:opencode': {
              service: 'opencode',
              offering: 'payg',
              normalizedEndpoint: 'cli:opencode',
              billing: 'provider-dependent',
              asOf: '',
            },
          },
        }),
      }),
    );

    expect(view.seats.plan).toEqual({
      kind: 'named',
      identity: 'OpenCode CLI · auto',
      short: 'auto',
    });
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
      tasks: [makeTask({ id: 'T001', title: 'New brief', file: 'src/new.ts' })],
    });
    const view = derive(
      makeSummary({
        totalTasks: 1,
        completedByLocal: 0,
        changedFiles: ['src/old.ts'],
        taskBreakdown: [booked({ taskId: taskId('T001'), taskTitle: 'Old brief' })],
        costBreakdown: makeCostBreakdown({ totalActualCost: 0.42 }),
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
    expect(view.cost).toEqual({ kind: 'priced', actual: 0.42, partial: false });
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
    expect(view.briefs).toMatchObject({ total: 5, passed: 1, escalated: 1, failed: 1 });
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
        driftSummary: { passed: true, score: 1, errorCount: 0, warningCount: 0 },
      }),
    );
    expect(view.review).toMatchObject({
      kind: 'written',
      verdict: 'pass',
      counts: { critical: 0, warning: 2, note: 1 },
      markdownPath: '',
      driftPassed: true,
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

  it('carries the score and the deviation counts', () => {
    const view = derive(
      makeSummary({ driftSummary: { passed: false, score: 0.6, errorCount: 1, warningCount: 1 } }),
    );
    expect(view.scope).toEqual({
      kind: 'checked',
      passed: false,
      score: 0.6,
      errors: 1,
      warnings: 1,
    });
  });
});

describe('cost', () => {
  it('is unmetered when every runner bills outside per-token metering', () => {
    const view = derive(
      makeSummary({
        costBreakdown: makeCostBreakdown({
          requestEstimate: unmeteredEstimate([
            {
              callId: 'planner-call',
              role: 'planner',
              usageBoundary: 'single-request',
              amount: null,
              knownSubtotal: 0,
              completeness: 'unavailable',
              reasons: ['unpriced-model'],
              billing: { posture: 'subscription-included', basis: 'observed-invocation' },
            },
          ]),
        }),
      }),
    );
    expect(view.cost).toEqual({ kind: 'unmetered', label: 'subscription-included' });
  });

  it('never prices a zero-token subscription crew as $0.00', () => {
    const view = derive(
      makeSummary({
        tokenUsage: makeUsage(),
        costBreakdown: makeCostBreakdown({
          requestEstimate: unmeteredEstimate([
            {
              callId: 'planner-call',
              role: 'planner',
              usageBoundary: 'single-request',
              amount: null,
              knownSubtotal: 0,
              completeness: 'unavailable',
              reasons: ['unpriced-model'],
              billing: { posture: 'subscription-included', basis: 'observed-invocation' },
            },
            {
              callId: 'implementer-call',
              role: 'implementer',
              usageBoundary: 'single-request',
              amount: null,
              knownSubtotal: 0,
              completeness: 'unavailable',
              reasons: ['unpriced-model'],
              billing: { posture: 'local', basis: 'local-transport' },
            },
          ]),
        }),
      }),
    );
    expect(view.cost).toEqual({ kind: 'unmetered', label: 'subscription-included · local' });
  });

  it('is unpriced when the run booked no priced usage', () => {
    const view = derive(
      makeSummary({ costBreakdown: makeCostBreakdown({ hasPricedUsage: false }) }),
    );
    expect(view.cost).toEqual({ kind: 'unpriced' });
  });

  it('is unpriced when the run has no cost breakdown at all', () => {
    expect(derive(makeSummary()).cost).toEqual({ kind: 'unpriced' });
  });

  it('carries the spend and nothing beside it when the run is priced', () => {
    const view = derive(
      makeSummary({
        costBreakdown: makeCostBreakdown({
          totalActualCost: 0.42,
        }),
      }),
    );
    expect(view.cost).toEqual({ kind: 'priced', actual: 0.42, partial: false });
  });

  it('marks a run partial when part of its spend has no price', () => {
    const view = derive(
      makeSummary({
        costBreakdown: makeCostBreakdown({
          totalActualCost: 0.42,
          hasUnpricedUsage: true,
          isTotalActualCostKnown: false,
        }),
      }),
    );
    expect(view.cost).toMatchObject({ kind: 'priced', partial: true });
  });

  it('has no cost view at all when the spend display is off', () => {
    const view = derive(
      makeSummary({ costBreakdown: makeCostBreakdown({ totalActualCost: 0.42 }) }),
      { showSpend: false },
    );
    expect(view.cost).toBeNull();
  });
});

describe('tokens', () => {
  it('sums input and output per seat and folds escalation into build', () => {
    const view = derive(
      makeSummary({
        tokenUsage: makeUsage({
          plannerInput: 10_000,
          plannerOutput: 2_300,
          implementerInput: 100_000,
          implementerOutput: 40_000,
          escalationInput: 6_000,
          escalationOutput: 2_000,
          reviewerInput: 15_000,
          reviewerOutput: 3_700,
        }),
      }),
    );
    expect(view.tokens).toEqual({ plan: 12_300, build: 148_000, review: 18_700 });
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
    expect(view.files.stoppedAt).toEqual({ taskId: taskId('T002'), partialFiles: ['src/b.ts'] });
  });

  it('keeps a legacy summary without a changed set distinct from an empty one', () => {
    expect(derive(makeSummary()).files.changed).toBeNull();
    expect(derive(makeSummary({ changedFiles: [] })).files.changed).toEqual([]);
  });
});

describe('checkpoint, phases and pass-through', () => {
  it('reports the run-level checkpoint decision the record carries', () => {
    expect(derive(makeSummary(), { checkpoint: { kind: 'accepted' } }).checkpoint).toBe('accepted');
    expect(derive(makeSummary(), { checkpoint: { kind: 'rejected' } }).checkpoint).toBe('rejected');
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

  it('carries the session id and clock from the record, and no mode', () => {
    const view = derive(makeSummary({ mode: 'standard', totalTime: 133_000 }), {
      ref: { projectDir: '/tmp/p', sessionId: '2026-09-14-add-email-validation' },
    });
    expect(view.run).toEqual({
      feature: expect.any(String),
      sessionId: '2026-09-14-add-email-validation',
      totalMs: 133_000,
      phase: expect.any(String),
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
