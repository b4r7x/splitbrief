import { describe, expect, it } from 'vitest';
import { PHASES } from '../../../core/schemas/enums.js';
import { deriveLiveStatus, stallRunnerHint } from './live-activity.js';
import { lifecycleStore } from '../../../stores/workflow/lifecycle.js';
import { addEvent } from '../../../stores/workflow/actions/event.js';
import { resetWorkflow } from '../../../stores/workflow/actions/reset.js';
import { makePlannerHeartbeat, makePlannerStatus } from '#testing/helpers/events/planner.js';
import { makeRunnerCallStarted } from '#testing/helpers/events/runner-call.js';

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
};

describe('deriveLiveStatus', () => {
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
    ['escalating', 'implementer'],
    ['final-review', 'validator'],
  ] as const)('derives %s with the live %s byline tone', (phase, tone) => {
    expect(deriveLiveStatus({ ...base, phase })).toMatchObject({ tone });
  });

  it('carries the verb, the stage start, and the role tone for a live planner stage', () => {
    const status = deriveLiveStatus({ ...base, phase: 'researching' });
    expect(status).toEqual({
      verb: 'Researching…',
      stageStart: 1000,
      waitedMs: 0,
      tone: 'planner',
    });
  });

  it('says one verb for the planning session and names an old chain briefs call', () => {
    expect(deriveLiveStatus({ ...base, phase: 'planning', plannerCall: 'plan' })?.verb).toBe(
      'Planning…',
    );
    expect(deriveLiveStatus({ ...base, phase: 'planning', plannerCall: 'tasks' })?.verb).toBe(
      'Compiling briefs…',
    );
    expect(deriveLiveStatus({ ...base, phase: 'planning' })?.verb).toBe('Planning…');
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
    expect(status?.tone).toBe('implementer');
    expect(status?.stageStart).toBe(5000);
  });

  // S8 run 18:06–18:58 and S11 run 02:29–02:39: a ten-minute `npm test` at the run start, a batch
  // boundary or before the review read `Implementing… 10:49`, the brief stage's clock.
  it.each([
    ['baseline', 'Run-start suite · npm test'],
    ['boundary', 'Batch suite · npm test'],
    ['pre-review', 'Pre-review suite · npm test'],
  ] as const)('names the %s suite stage and its command on its own clock', (moment, verb) => {
    const status = deriveLiveStatus({
      ...base,
      phase: 'implementing',
      phaseFirstSeenTs: { implementing: 5_000 },
      waitedMs: { implementing: 2_000 },
      suiteStage: { stage: 'test', command: 'npm test', moment, stageStartedTs: 90_000 },
    });
    expect(status).toEqual({ verb, stageStart: 90_000, waitedMs: 0, tone: 'validator' });
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
      verb: 'Researching…',
      stageStart: 1000,
      waitedMs: 7_000,
      tone: 'planner',
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
    expect(liveNow()).toMatchObject({
      verb: 'Planning…',
      stageStart: 50_000,
      tone: 'planner',
    });
    addEvent(makePlannerStatus({ phase: 'planning', ts: 60_000, status: 'done', call: 'plan' }));
    addEvent(makePlannerStatus({ phase: 'reviewing-plan', ts: 60_001 }));
    expect(liveNow()).toBeNull();

    regenerate('reviewing-spec', 'spec');
    expect(liveNow()).toMatchObject({ verb: 'Specifying…', stageStart: 50_000 });

    regenerate('reviewing-briefs', 'tasks');
    expect(lifecycleStore.get().phase).toBe('reviewing-briefs');
    expect(liveNow()).toMatchObject({ verb: 'Compiling briefs…', stageStart: 50_000 });
  });

  it('names the reviewer seat during final review and keeps the seatless wording without one', () => {
    const configured = deriveLiveStatus({
      ...base,
      phase: 'final-review',
      reviewerLabel: 'Sonnet 4.5',
    });
    expect(configured?.verb).toContain('Sonnet 4.5');
    expect(configured?.tone).toBe('validator');

    const unconfigured = deriveLiveStatus({ ...base, phase: 'final-review' });
    expect(unconfigured?.verb).toBe('Review…');
    expect(unconfigured?.tone).toBe('validator');
  });

  it('live verbs are Title Case', () => {
    const verbs = PHASES.flatMap((phase) => deriveLiveStatus({ ...base, phase })?.verb ?? []);
    expect(verbs.length).toBeGreaterThan(0);
    for (const verb of verbs) {
      expect(verb).toMatch(/^[A-Z]/);
    }
  });
});

describe('stallRunnerHint', () => {
  it('explains the silence for a runner that only reports finished tools', () => {
    expect(stallRunnerHint('opencode', 'cli')).toBe('tools report when done');
    expect(stallRunnerHint('opencode')).toBe('tools report when done');
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
