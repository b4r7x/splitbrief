import { describe, expect, it } from 'vitest';
import { PHASES } from '../../../core/schemas/enums.js';
import { deriveLiveStatus, stallRunnerHint } from './live-activity.js';
import { lifecycleStore } from '../../../stores/workflow/lifecycle.js';
import { addEvent } from '../../../stores/workflow/actions/event.js';
import { resetWorkflow } from '../../../stores/workflow/actions/reset.js';
import { makePlannerHeartbeat, makePlannerStatus } from '#testing/helpers/events/planner.js';
import {
  makeRunnerCallStarted,
  makeRunnerCallCompleted,
} from '#testing/helpers/events/runner-call.js';
import { operationsStore } from '../../../stores/workflow/operations/state.js';
import { taskId } from '../../../core/schemas/task.js';

const base = {
  status: 'running' as const,
  cancelled: false,
  startedAt: 1000,
  phaseFirstSeenTs: {},
  waitedMs: {},
  resumedAt: null,
  reviewerLabel: null,
  plannerCall: null,
  plannerCallStartedTs: null,
  suiteStage: null,
  activeOperation: null,
};

it.each([
  ['shell', 'Custom Shell'],
  ['agent', 'Agent'],
] as const)('names a recorded %s reviewer in the configured seat words', (backendKind, label) => {
  resetWorkflow();
  addEvent(
    makeRunnerCallStarted({
      phase: 'final-review',
      role: 'review',
      backendKind,
      runnerName: backendKind,
      model: 'gpt-5',
    }),
  );
  expect(
    deriveLiveStatus({
      ...base,
      phase: 'final-review',
      activeOperation: operationsStore.get().active,
    })
      ?.parts.map((part) => part.text)
      .join(''),
  ).toBe(`Review · ${label} · GPT-5`);
  resetWorkflow();
});

it('names the active reviewer from its recorded identity after the configured seat changes', () => {
  resetWorkflow();
  addEvent(
    makeRunnerCallStarted({
      phase: 'final-review',
      role: 'review',
      runnerName: 'codex',
      model: 'gpt-5',
      axes: ['high'],
      ts: 60_000,
    }),
  );
  expect(
    deriveLiveStatus({
      ...base,
      phase: 'final-review',
      activeOperation: operationsStore.get().active,
      reviewerLabel: 'Claude Code CLI · Sonnet 5 · low',
    })
      ?.parts.map((part) => part.text)
      .join(''),
  ).toBe('Review · OpenAI Codex CLI · GPT-5 · high');
  resetWorkflow();
});

it('leads the review byline with the render scenario and its own clock', () => {
  const status = deriveLiveStatus({
    ...base,
    phase: 'final-review',
    suiteStage: {
      id: 'R1',
      moment: 'plan',
      scenario: 'workflow-x',
      command: 'npm run tui-shots -- --scenario workflow-x --output /tmp/render',
      stageStartedTs: 90_000,
    },
  });
  expect(status).toEqual({
    parts: [
      { text: 'Review', tone: 'reviewer' },
      { text: ' · ', tone: 'textDim' },
      { text: 'Render workflow-x', tone: 'accent' },
    ],
    stageStart: 90_000,
    waitedMs: 0,
  });
});

describe('deriveLiveStatus', () => {
  it.each([
    ['task', 'implementing'],
    ['final', 'final-review'],
  ] as const)(
    'keeps the recorded %s reviewer through the marker, calls, gaps and checks',
    (scope, phase) => {
      resetWorkflow();
      addEvent({ type: 'workflow_started', ts: 500, phase, feature: 'test' });
      addEvent({
        type: 'review_started',
        ts: 1_000,
        phase,
        scope,
        tool: 'codex',
        model: 'gpt-5',
        axes: ['high'],
        ...(scope === 'task' && { afterTaskId: 'T001' }),
      });
      addEvent({ type: 'review_step', ts: 1_000, phase, step: 'choosing-checks' });
      const liveNow = () =>
        deriveLiveStatus({
          ...base,
          phase,
          reviewerLabel: 'Claude Code CLI · Sonnet 5 · low',
          activeOperation: operationsStore.get().active,
          suiteStage: operationsStore.get().suiteStage ?? null,
        });
      const reviewer = 'Review · OpenAI Codex CLI · GPT-5 · high';
      expect(liveNow()).toMatchObject({
        parts: [
          { text: 'Review', tone: 'reviewer' },
          { text: ' · ', tone: 'textDim' },
          { text: 'OpenAI Codex CLI · GPT-5 · high', tone: 'reviewer' },
          { text: ' · ', tone: 'textDim' },
          { text: 'choosing checks', tone: 'textDim' },
        ],
        stageStart: 1_000,
      });
      addEvent(
        makeRunnerCallStarted({
          ts: 1_100,
          phase,
          role: 'review',
          callId: 'review-plan',
          runnerName: 'codex',
          model: 'gpt-5',
          axes: ['high'],
        }),
      );
      expect(liveNow()).toMatchObject({
        parts: [
          { text: 'Review', tone: 'reviewer' },
          { text: ' · ', tone: 'textDim' },
          { text: 'OpenAI Codex CLI · GPT-5 · high', tone: 'reviewer' },
          { text: ' · ', tone: 'textDim' },
          { text: 'choosing checks', tone: 'textDim' },
        ],
        stageStart: 1_100,
      });
      addEvent(
        makeRunnerCallCompleted({
          ts: 1_200,
          phase,
          role: 'review',
          callId: 'review-plan',
          startedAt: 1_100,
          endedAt: 1_200,
          durationMs: 100,
        }),
      );
      expect(
        liveNow()
          ?.parts.map((part) => part.text)
          .join(''),
      ).toBe(`${reviewer} · choosing checks`);
      addEvent({
        type: 'review_checks',
        ts: 1_250,
        phase,
        scope,
        status: 'planned',
        commands: [],
        declined: [],
        reason: 'No checks needed.',
      });
      addEvent({
        type: 'full_suite',
        ts: 1_300,
        phase,
        id: 'V1',
        moment: 'pre-review',
        command: 'npm test',
        status: 'running',
      });
      expect(liveNow()).toMatchObject({
        parts: [
          { text: 'Review', tone: 'reviewer' },
          { text: ' · ', tone: 'textDim' },
          { text: 'Reviewer', tone: 'reviewer' },
          { text: ' check V1', tone: 'textDim' },
          { text: ' · ', tone: 'textDim' },
          { text: 'npm test', tone: 'textDim' },
        ],
        stageStart: 1_300,
      });
      addEvent({
        type: 'full_suite',
        ts: 1_400,
        phase,
        id: 'V1',
        moment: 'pre-review',
        command: 'npm test',
        status: 'done',
        passed: true,
      });
      expect(
        liveNow()
          ?.parts.map((part) => part.text)
          .join(''),
      ).toBe(`${reviewer} · reviewing changes`);
      addEvent(
        makeRunnerCallStarted({
          ts: 1_500,
          phase,
          role: 'review',
          callId: 'review-verdict',
          runnerName: 'codex',
          model: 'gpt-5',
          axes: ['high'],
        }),
      );
      expect(
        liveNow()
          ?.parts.map((part) => part.text)
          .join(''),
      ).toBe(`${reviewer} · reviewing changes`);
      addEvent(
        makeRunnerCallCompleted({
          ts: 1_600,
          phase,
          role: 'review',
          callId: 'review-verdict',
          startedAt: 1_500,
          endedAt: 1_600,
          durationMs: 100,
        }),
      );
      addEvent({
        type: 'review_completed',
        ts: 1_700,
        phase,
        scope,
        tool: 'codex',
        verdict: 'pass',
        duration: 700,
      });
      expect(
        liveNow()
          ?.parts.map((part) => part.text)
          .join(''),
      ).toBe(scope === 'task' ? 'Implementing…' : 'Review · reviewing changes');
      resetWorkflow();
    },
  );
  it.each(['implementing', 'escalating'] as const)(
    'names the active reviewer consult during %s on the call clock',
    (phase) => {
      resetWorkflow();
      addEvent(
        makeRunnerCallStarted({ phase, role: 'review', taskId: taskId('T013'), ts: 60_000 }),
      );
      const activeOperation = operationsStore.get().active;
      expect(
        deriveLiveStatus({
          ...base,
          phase,
          reviewerLabel: 'GPT-6 Astra',
          activeOperation,
        }),
      ).toEqual({
        parts: [
          { text: 'Review', tone: 'reviewer' },
          { text: ' · ', tone: 'textDim' },
          { text: 'GPT-6 Astra', tone: 'reviewer' },
        ],
        stageStart: 60_000,
        waitedMs: 0,
      });
      expect(
        deriveLiveStatus({ ...base, phase, activeOperation: null })
          ?.parts.map((part) => part.text)
          .join(''),
      ).toBe(phase === 'implementing' ? 'Implementing…' : 'Escalating…');
      resetWorkflow();
    },
  );
  it('is null when idle, complete, cancelled, or at a review gate', () => {
    expect(deriveLiveStatus({ ...base, phase: 'idle' })).toBeNull();
    expect(deriveLiveStatus({ ...base, phase: 'complete' })).toBeNull();
    expect(deriveLiveStatus({ ...base, phase: 'researching', cancelled: true })).toBeNull();
    expect(deriveLiveStatus({ ...base, phase: 'reviewing-spec' })).toBeNull();
    expect(deriveLiveStatus({ ...base, phase: 'reviewing-plan' })).toBeNull();
    expect(deriveLiveStatus({ ...base, phase: 'reviewing-briefs' })).toBeNull();
  });

  it('deriveLiveStatus returns null unless the lifecycle is running', () => {
    expect(deriveLiveStatus({ ...base, phase: 'researching', status: 'interrupted' })).toBeNull();
  });

  it('deriveLiveStatus emits no spinner for paused', () => {
    expect(deriveLiveStatus({ ...base, phase: 'implementing', status: 'paused' })).toBeNull();
  });

  it.each([
    ['specifying', 'planner'],
    ['clarifying', 'planner'],
    ['constitution-check', 'planner'],
    ['planning', 'planner'],
    ['analyzing', 'planner'],
    ['validating-task', 'implementer'],
    ['escalating', 'planner'],
    ['final-review', 'reviewer'],
  ] as const)('derives %s with the live %s byline tone', (phase, tone) => {
    expect(deriveLiveStatus({ ...base, phase })).toEqual({
      parts:
        phase === 'final-review'
          ? [
              { text: 'Review', tone: 'reviewer' },
              { text: ' · ', tone: 'textDim' },
              { text: 'reviewing changes', tone: 'textDim' },
            ]
          : [
              {
                text:
                  phase === 'specifying'
                    ? 'Specifying…'
                    : phase === 'clarifying'
                      ? 'Clarifying…'
                      : phase === 'constitution-check'
                        ? 'Checking constitution…'
                        : phase === 'planning'
                          ? 'Planning…'
                          : phase === 'analyzing'
                            ? 'Analyzing…'
                            : phase === 'validating-task'
                              ? 'Validating…'
                              : 'Escalating…',
                tone,
              },
            ],
      stageStart:
        phase === 'validating-task' || phase === 'escalating' || phase === 'final-review'
          ? 0
          : 1000,
      waitedMs: 0,
    });
  });

  it('carries the verb, the stage start, and the role tone for a live planner stage', () => {
    const status = deriveLiveStatus({ ...base, phase: 'researching' });
    expect(status).toEqual({
      parts: [{ text: 'Researching…', tone: 'planner' }],
      stageStart: 1000,
      waitedMs: 0,
    });
  });

  it('says one verb for the planning session and names an old chain briefs call', () => {
    expect(
      deriveLiveStatus({ ...base, phase: 'planning', plannerCall: 'plan' })
        ?.parts.map((part) => part.text)
        .join(''),
    ).toBe('Planning…');
    expect(
      deriveLiveStatus({ ...base, phase: 'planning', plannerCall: 'tasks' })
        ?.parts.map((part) => part.text)
        .join(''),
    ).toBe('Compiling briefs…');
    expect(
      deriveLiveStatus({ ...base, phase: 'planning' })
        ?.parts.map((part) => part.text)
        .join(''),
    ).toBe('Planning…');
  });

  it('adds up the waits of the active stage only', () => {
    const status = deriveLiveStatus({
      ...base,
      phase: 'specifying',
      waitedMs: { researching: 4_000, specifying: 1_000, planning: 9_000, implementing: 500 },
    });
    expect(status?.waitedMs).toBe(14_000);

    const build = deriveLiveStatus({
      ...base,
      phase: 'validating-task',
      phaseFirstSeenTs: { implementing: 5_000 },
      waitedMs: { researching: 4_000, implementing: 500 },
    });
    expect(build?.waitedMs).toBe(500);
  });

  it('uses the implementer tone during build and derives stage start from phaseFirstSeenTs', () => {
    const status = deriveLiveStatus({
      ...base,
      phase: 'implementing',
      phaseFirstSeenTs: { implementing: 5000 },
    });
    expect(status?.parts).toEqual([{ text: 'Implementing…', tone: 'implementer' }]);
    expect(status?.stageStart).toBe(5000);
  });

  it.each([
    ['pre-review', 'Pre-review suite · npm test'],
    ['base', 'Base re-run · npm test'],
  ] as const)('names the %s suite stage and its command on its own clock', (moment, verb) => {
    const status = deriveLiveStatus({
      ...base,
      phase: 'implementing',
      phaseFirstSeenTs: { implementing: 5_000 },
      waitedMs: { implementing: 2_000 },
      suiteStage: { stage: 'test', command: 'npm test', moment, stageStartedTs: 90_000 },
    });
    expect(status).toEqual({
      parts: [
        {
          text: moment === 'base' ? 'Base re-run' : 'Pre-review suite',
          tone: moment === 'base' ? 'accent' : 'textDim',
        },
        { text: ' · ', tone: 'textDim' },
        { text: 'npm test', tone: 'textDim' },
      ],
      stageStart: 90_000,
      waitedMs: 0,
    });
    expect(status?.parts.map((part) => part.text).join('')).toBe(verb);
  });

  it.each([
    ['pre-review', 'Review · Reviewer check V1 · npm test'],
    ['base', 'Review · Base re-run V1 · npm test'],
    ['brief', 'Review · Fix check V1 · npm test'],
  ] as const)('names the %s reviewer check by its id on its own clock', (moment, verb) => {
    const status = deriveLiveStatus({
      ...base,
      phase: 'final-review',
      phaseFirstSeenTs: { 'final-review': 5_000 },
      suiteStage: { id: 'V1', command: 'npm test', moment, stageStartedTs: 90_000 },
    });
    expect(status).toEqual({
      parts: [
        { text: 'Review', tone: 'reviewer' },
        { text: ' · ', tone: 'textDim' },
        ...(moment === 'pre-review'
          ? [
              { text: 'Reviewer', tone: 'reviewer' },
              { text: ' check V1', tone: 'textDim' },
            ]
          : [{ text: moment === 'base' ? 'Base re-run V1' : 'Fix check V1', tone: 'accent' }]),
        { text: ' · ', tone: 'textDim' },
        { text: 'npm test', tone: 'textDim' },
      ],
      stageStart: 90_000,
      waitedMs: 0,
    });
    expect(status?.parts.map((part) => part.text).join('')).toBe(verb);
  });

  it('counts the stage from the later of its opening and the run resuming', () => {
    const resumedMidStage = deriveLiveStatus({
      ...base,
      phase: 'planning',
      phaseFirstSeenTs: { planning: 5_000 },
      resumedAt: 90_000,
    });
    expect(resumedMidStage?.stageStart).toBe(90_000);

    const openedAfterResume = deriveLiveStatus({
      ...base,
      phase: 'implementing',
      phaseFirstSeenTs: { planning: 5_000, implementing: 120_000 },
      resumedAt: 90_000,
    });
    expect(openedAfterResume?.stageStart).toBe(120_000);

    const firstStage = deriveLiveStatus({ ...base, phase: 'researching', resumedAt: 90_000 });
    expect(firstStage?.stageStart).toBe(90_000);
  });

  it('opens the Plan clock with the run and counts the waits of every pre-build phase', () => {
    const waits = { researching: 1_000, specifying: 2_000, planning: 4_000, implementing: 8_000 };
    const oldChain = deriveLiveStatus({ ...base, phase: 'researching', waitedMs: waits });
    expect(oldChain).toEqual({
      parts: [{ text: 'Researching…', tone: 'planner' }],
      stageStart: 1000,
      waitedMs: 7_000,
    });

    const planning = deriveLiveStatus({
      ...base,
      phase: 'planning',
      phaseFirstSeenTs: { researching: 2_000, planning: 50_000 },
      waitedMs: waits,
    });
    expect(planning?.stageStart).toBe(1000);
    expect(planning?.waitedMs).toBe(7_000);
  });

  it('counts the planner call the engine names, and the stage once it names none', () => {
    const planStage = {
      ...base,
      phase: 'planning' as const,
      phaseFirstSeenTs: { planning: 5_000 },
    };

    expect(
      deriveLiveStatus({ ...planStage, plannerCall: 'tasks', plannerCallStartedTs: 60_000 })
        ?.stageStart,
    ).toBe(60_000);
    expect(deriveLiveStatus({ ...planStage, plannerCallStartedTs: 60_000 })?.stageStart).toBe(
      base.startedAt,
    );
    expect(
      deriveLiveStatus({
        ...planStage,
        plannerCall: 'tasks',
        plannerCallStartedTs: 60_000,
        resumedAt: 90_000,
      })?.stageStart,
    ).toBe(90_000);
  });

  it('stays live while the planner rewrites a gate document from a change request', () => {
    const liveNow = () => {
      const lifecycle = lifecycleStore.get();
      return deriveLiveStatus({
        ...base,
        phase: lifecycle.phase,
        status: lifecycle.status,
        startedAt: lifecycle.startedAt,
        phaseFirstSeenTs: lifecycle.phaseFirstSeenTs,
        plannerCall: lifecycle.plannerCall ?? null,
        plannerCallStartedTs: lifecycle.plannerCallStartedTs ?? null,
      });
    };
    const regenerate = (
      gate: 'reviewing-spec' | 'reviewing-plan' | 'reviewing-briefs',
      call: 'spec' | 'plan' | 'tasks',
    ) => {
      const statusPhase = call === 'spec' ? 'specifying' : 'planning';
      resetWorkflow();
      addEvent({ type: 'workflow_started', ts: 1_000, phase: 'researching', feature: 'test' });
      addEvent(makePlannerStatus({ phase: statusPhase, ts: 2_000, call }));
      addEvent(makePlannerStatus({ phase: gate, ts: 3_000 }));
      addEvent(makePlannerStatus({ phase: statusPhase, ts: 50_000, call }));
      addEvent(makePlannerHeartbeat({ phase: statusPhase, ts: 50_000 }));
      addEvent(makeRunnerCallStarted({ phase: gate, ts: 50_010 }));
    };

    regenerate('reviewing-plan', 'plan');
    expect(lifecycleStore.get().phase).toBe('reviewing-plan');
    expect(liveNow()).toEqual({
      parts: [{ text: 'Planning…', tone: 'planner' }],
      waitedMs: 0,
      stageStart: 50_000,
    });
    addEvent(makePlannerStatus({ phase: 'planning', ts: 60_000, status: 'done', call: 'plan' }));
    addEvent(makePlannerStatus({ phase: 'reviewing-plan', ts: 60_001 }));
    expect(liveNow()).toBeNull();

    regenerate('reviewing-spec', 'spec');
    expect(liveNow()).toEqual({
      parts: [{ text: 'Specifying…', tone: 'planner' }],
      stageStart: 50_000,
      waitedMs: 0,
    });

    regenerate('reviewing-briefs', 'tasks');
    expect(lifecycleStore.get().phase).toBe('reviewing-briefs');
    expect(liveNow()).toEqual({
      parts: [{ text: 'Compiling briefs…', tone: 'planner' }],
      stageStart: 50_000,
      waitedMs: 0,
    });
  });

  it('names the reviewer seat during final review only while a call runs, and names the step otherwise', () => {
    const running = {
      callId: 'call-1',
      role: 'review' as const,
      phase: 'final-review' as const,
      label: 'review',
      startedAt: 1000,
      status: 'running' as const,
      endedAt: null,
      durationMs: null,
      partial: false as const,
      reason: null,
      usage: null,
      warnings: [],
    };
    const configured = deriveLiveStatus({
      ...base,
      phase: 'final-review',
      reviewerLabel: 'Sonnet 4.5',
      activeOperation: running,
    });
    expect(configured?.parts.map((part) => part.text).join('')).toContain('Sonnet 4.5');

    const betweenCalls = deriveLiveStatus({
      ...base,
      phase: 'final-review',
      reviewerLabel: 'Sonnet 4.5',
      activeOperation: null,
    });
    expect(betweenCalls?.parts.map((part) => part.text).join('')).toBe(
      'Review · reviewing changes',
    );

    const unconfigured = deriveLiveStatus({
      ...base,
      phase: 'final-review',
      activeOperation: running,
    });
    expect(unconfigured?.parts.map((part) => part.text).join('')).toBe('Review · reviewing');
  });

  it('live verbs are Title Case', () => {
    const verbs = PHASES.flatMap(
      (phase) =>
        deriveLiveStatus({ ...base, phase })
          ?.parts.map((part) => part.text)
          .join('') ?? [],
    );
    expect(verbs.length).toBeGreaterThan(0);
    for (const verb of verbs) {
      expect(verb).toMatch(/^[A-Z]/);
    }
  });

  it.each(['planner', 'implementer'] as const)(
    'reads the %s role in the final review as no reviewer call',
    (role) => {
      const activeOperation = {
        callId: 'stage-marker',
        role,
        phase: 'final-review' as const,
        label: `${role} final-review`,
        startedAt: 1000,
        status: 'running' as const,
        endedAt: null,
        durationMs: null,
        partial: false as const,
        reason: null,
        usage: null,
        warnings: [],
      };
      expect(
        deriveLiveStatus({
          ...base,
          phase: 'final-review',
          reviewerLabel: 'GPT-6 Astra',
          activeOperation,
        })
          ?.parts.map((part) => part.text)
          .join(''),
      ).toBe('Review · reviewing changes');
    },
  );

  it.each(['summary', 'compaction', 'escalation'] as const)(
    'names the %s step without inheriting the reviewer identity',
    (role) => {
      const activeOperation = {
        callId: 'side-call',
        role,
        phase: 'final-review' as const,
        label: `${role} final-review (codex gpt-6-astra)`,
        startedAt: 1000,
        status: 'running' as const,
        endedAt: null,
        durationMs: null,
        partial: false as const,
        reason: null,
        usage: null,
        warnings: [],
      };
      const verb = deriveLiveStatus({
        ...base,
        phase: 'final-review',
        reviewerLabel: 'GPT-6 Astra',
        activeOperation,
      })
        ?.parts.map((part) => part.text)
        .join('');
      expect(verb).toMatch(/^Review · /);
      expect(verb?.toLowerCase()).toContain(role);
      expect(verb).not.toContain('GPT-6 Astra');
      expect(verb).not.toContain('final-review');
    },
  );

  it('keeps a fix check in Build without a Review prefix', () => {
    expect(
      deriveLiveStatus({
        ...base,
        phase: 'implementing',
        suiteStage: { id: 'V1', command: 'npm test', moment: 'brief', stageStartedTs: 2000 },
      })
        ?.parts.map((part) => part.text)
        .join(''),
    ).toBe('Fix check V1 · npm test');
  });
});

describe('stallRunnerHint', () => {
  it('explains the silence for a runner that only reports finished tools', () => {
    expect(stallRunnerHint('opencode', 'cli')).toBe('tools report when done');
    expect(stallRunnerHint('opencode')).toBe('tools report when done');
    expect(stallRunnerHint('kilo-code', 'cli')).toBe('tools report when done');
  });

  it('never hands the CLI hint to an API call that reuses the name', () => {
    expect(stallRunnerHint('opencode', 'api')).toBeNull();
    expect(stallRunnerHint('opencode', 'shell')).toBeNull();
    expect(stallRunnerHint('opencode', 'agent')).toBeNull();
  });

  it('stays silent for runners that stream tool use live, and when the runner is unknown', () => {
    expect(stallRunnerHint('claude-code', 'cli')).toBeNull();
    expect(stallRunnerHint('codex', 'cli')).toBeNull();
    expect(stallRunnerHint(null, 'cli')).toBeNull();
  });

  it('is short enough to sit inside the byline', () => {
    expect((stallRunnerHint('opencode', 'cli') ?? '').length).toBeLessThanOrEqual(24);
  });
});

it.each(['planning', 'implementing', 'final-review'] as const)(
  'keeps running check labels and metadata in their own tones during %s',
  (phase) => {
    expect(
      deriveLiveStatus({
        ...base,
        phase,
        suiteStage: { id: 'V1', command: 'npm test', moment: 'plan', stageStartedTs: 2000 },
      }),
    ).toEqual({
      parts: [
        ...(phase === 'final-review'
          ? [
              { text: 'Review', tone: 'reviewer' },
              { text: ' · ', tone: 'textDim' },
            ]
          : []),
        { text: 'Plan', tone: 'planner' },
        { text: ' check V1', tone: 'textDim' },
        { text: ' · ', tone: 'textDim' },
        { text: 'npm test', tone: 'textDim' },
      ],
      stageStart: 2000,
      waitedMs: 0,
    });
  },
);

it('carries only the structured Review and Reviewer words in the reviewer tone', () => {
  expect(
    deriveLiveStatus({
      ...base,
      phase: 'final-review',
      suiteStage: { id: 'V1', command: 'npm test', moment: 'pre-review', stageStartedTs: 2000 },
    })?.parts,
  ).toEqual([
    { text: 'Review', tone: 'reviewer' },
    { text: ' · ', tone: 'textDim' },
    { text: 'Reviewer', tone: 'reviewer' },
    { text: ' check V1', tone: 'textDim' },
    { text: ' · ', tone: 'textDim' },
    { text: 'npm test', tone: 'textDim' },
  ]);
});

it('keeps separators inside a working reviewer identity in the seat tone', () => {
  resetWorkflow();
  addEvent(makeRunnerCallStarted({ phase: 'final-review', role: 'review', ts: 60_000 }));
  expect(
    deriveLiveStatus({
      ...base,
      phase: 'final-review',
      reviewerLabel: 'Codex CLI · GPT-6 Astra',
      activeOperation: operationsStore.get().active,
    })?.parts,
  ).toEqual([
    { text: 'Review', tone: 'reviewer' },
    { text: ' · ', tone: 'textDim' },
    { text: 'Codex CLI · GPT-6 Astra', tone: 'reviewer' },
  ]);
  resetWorkflow();
});

it('keeps Implementing in the build seat tone during a planner consult', () => {
  resetWorkflow();
  addEvent(makeRunnerCallStarted({ phase: 'implementing', role: 'planner', ts: 60_000 }));
  expect(
    deriveLiveStatus({
      ...base,
      phase: 'implementing',
      activeOperation: operationsStore.get().active,
    }),
  ).toEqual({
    parts: [{ text: 'Implementing…', tone: 'implementer' }],
    stageStart: 0,
    waitedMs: 0,
  });
  resetWorkflow();
});

it.each(['planner', 'escalation'] as const)(
  'keeps a running %s consult in the planner tone during Build',
  (role) => {
    resetWorkflow();
    addEvent(
      makeRunnerCallStarted({ phase: 'escalating', role, taskId: taskId('T013'), ts: 60_000 }),
    );
    expect(
      deriveLiveStatus({
        ...base,
        phase: 'escalating',
        activeOperation: operationsStore.get().active,
      }),
    ).toEqual({
      parts: [{ text: 'Escalating…', tone: 'planner' }],
      stageStart: 0,
      waitedMs: 0,
    });
    resetWorkflow();
  },
);
