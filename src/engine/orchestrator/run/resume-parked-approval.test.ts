import { afterEach, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultContext, makeConfig } from '#testing/helpers/factories/config.js';
import { makePhaseCallResult } from '#testing/helpers/factories/phase-call.js';
import {
  makeBusRecorder,
  makeCallbacks,
  makePlanner,
  makeWctx,
} from '#testing/helpers/orchestrator-factories.js';
import {
  REAL_TASKS_MD,
  makeBriefQualityFailureTask,
  makePassingPlanner,
  makePassingTask,
} from '#testing/helpers/planning-phase.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import {
  BRIEF_QUALITY_FILE,
  CLARIFICATIONS_FILE,
  CONSTITUTION_CHECK_FILE,
  PLAN_FILE,
  RESEARCH_FILE,
  SPEC_FILE,
  TASKS_FILE,
  sessionDir,
} from '../../../core/paths.js';
import { ensureSessionDir } from '../../../core/paths-io.js';
import { createInitialState, transition } from '../../../core/state/machine.js';
import { loadState, saveState } from '../../../core/state/persistence.js';
import type { ApproveLevel } from '../../../core/schemas/enums.js';
import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { EngineEvent } from '../../events/types.js';
import type { Planner } from '../../planners/types.js';
import { formatTasks } from '../../spec/formatter.js';
import { resumeParkedApproval } from './resume-parked-approval.js';
import { runPlanningPhases } from './phases.js';

let projectDir = '';
afterEach(() => cleanupTempDir(projectDir));

/** A standard run parked at its plan gate, over the briefs its tasks step wrote. */
function parkAtPlanGate(tasks: Task[]): { sessionId: string; state: WorkflowState } {
  projectDir = createTempDir('parked-plan-approval');
  const sessionId = 'sess-parked-plan';
  ensureSessionDir(projectDir, sessionId);
  const dir = sessionDir(projectDir, sessionId);
  writeFileSync(join(dir, RESEARCH_FILE), '# Research\n\nFindings\n');
  writeFileSync(join(dir, SPEC_FILE), '# Spec\n\nRequirement A\n');
  writeFileSync(join(dir, PLAN_FILE), '# Plan\n\nStep 1\n');
  writeFileSync(join(dir, TASKS_FILE), formatTasks(tasks));
  let state = createInitialState('feature');
  for (const action of [
    { type: 'START' },
    { type: 'RESEARCH_DONE' },
    { type: 'SPEC_DONE' },
    { type: 'APPROVE_SPEC' },
    { type: 'PLAN_DONE', tasks },
  ] as const) {
    state = transition(state, action);
  }
  return { sessionId, state: { ...state, mode: 'standard', approve: 'all' } };
}

function qualityVerdicts(events: readonly EngineEvent[]): string[] {
  return events.flatMap((event) =>
    event.type === 'brief_quality_passed' || event.type === 'brief_quality_failed'
      ? [event.type]
      : [],
  );
}

/**
 * Continues the parked run in this process and approves each gate once; a briefs gate that asks
 * again ends the run. Each briefs prompt records the verdicts published before it and whether a
 * quality report was on disk.
 */
async function continueParked(opts: {
  sessionId: string;
  state: WorkflowState;
  planner: Planner;
  approve: ApproveLevel;
}) {
  const recorder = makeBusRecorder();
  const qualityPath = join(sessionDir(projectDir, opts.sessionId), BRIEF_QUALITY_FILE);
  const briefsPrompts: Array<{ verdicts: string[]; report: boolean }> = [];
  const result = await resumeParkedApproval({
    wctx: makeWctx({
      projectDir,
      sessionId: opts.sessionId,
      planner: opts.planner,
      bus: recorder.bus,
      config: makeConfig({ workflow: { mode: 'standard', approve: opts.approve, maxRetries: 2 } }),
      callbacks: makeCallbacks({
        onApprovalNeeded: async (gate) => {
          if (gate !== 'briefs') return { approved: true };
          briefsPrompts.push({
            verdicts: qualityVerdicts(recorder.events),
            report: existsSync(qualityPath),
          });
          return briefsPrompts.length === 1
            ? { approved: true }
            : { approved: false, action: 'end-run' };
        },
      }).callbacks,
    }),
    state: opts.state,
    setTrackedState: () => {},
    phaseTimings: {},
    startTime: Date.now(),
  });
  return { result, briefsPrompts, verdicts: qualityVerdicts(recorder.events) };
}

it('measures the briefs before the briefs gate opens when a parked plan gate is approved', async () => {
  const { sessionId, state } = parkAtPlanGate([makePassingTask()]);
  const planner = makePassingPlanner();
  const runPhase = vi.spyOn(planner, 'runPhase');
  const review = vi.spyOn(planner, 'review');

  const { result, briefsPrompts, verdicts } = await continueParked({
    sessionId,
    state,
    planner,
    approve: 'all',
  });

  expect(briefsPrompts).toEqual([{ verdicts: ['brief_quality_passed'], report: true }]);
  expect(result).toMatchObject({
    disposition: 'ready-for-tasks',
    state: { phase: 'implementing' },
  });
  expect(runPhase).not.toHaveBeenCalled();
  expect(review).not.toHaveBeenCalled();
  // The approval measures the same briefs again and announces nothing new.
  expect(verdicts).toEqual(['brief_quality_passed']);
});

it('repairs failing briefs before the briefs gate opens when a parked plan gate is approved', async () => {
  const { sessionId, state } = parkAtPlanGate([makeBriefQualityFailureTask()]);
  const review = vi.fn().mockResolvedValue({ text: REAL_TASKS_MD, usage: null });

  const { result, briefsPrompts, verdicts } = await continueParked({
    sessionId,
    state,
    planner: makePassingPlanner({ review }),
    approve: 'all',
  });

  expect(review).toHaveBeenCalledTimes(1);
  expect(review.mock.calls[0]?.[0]).toContain('Task T001 has no scope definition');
  expect(briefsPrompts).toEqual([
    { verdicts: ['brief_quality_failed', 'brief_quality_passed'], report: true },
  ]);
  expect(readFileSync(join(sessionDir(projectDir, sessionId), TASKS_FILE), 'utf8')).toContain(
    'title: Add auth',
  );
  expect(result).toMatchObject({ disposition: 'ready-for-tasks', tasks: [{ title: 'Add auth' }] });
  expect(verdicts).toEqual(['brief_quality_failed', 'brief_quality_passed']);
});

it('measures the briefs before the briefs gate opens when a parked spec gate is approved', async () => {
  projectDir = createTempDir('parked-spec-approval');
  const sessionId = 'sess-parked-spec-briefs';
  ensureSessionDir(projectDir, sessionId);
  const dir = sessionDir(projectDir, sessionId);
  writeFileSync(join(dir, RESEARCH_FILE), '# Research\n\nFindings\n');
  writeFileSync(join(dir, SPEC_FILE), '# Spec\n\nRequirement A\n');
  const state: WorkflowState = {
    ...createInitialState('feature'),
    phase: 'reviewing-spec',
    mode: 'standard',
    approve: 'spec',
  };

  const { result, briefsPrompts, verdicts } = await continueParked({
    sessionId,
    state,
    planner: makePassingPlanner(),
    approve: 'spec',
  });

  expect(briefsPrompts).toEqual([{ verdicts: ['brief_quality_passed'], report: true }]);
  expect(result).toMatchObject({
    disposition: 'ready-for-tasks',
    state: { phase: 'implementing' },
  });
  expect(verdicts).toEqual(['brief_quality_passed']);
});

it.each(['all', 'none'] as const)(
  'persists repaired briefs for execution with approval level %s',
  async (approve) => {
    const { sessionId, state } = parkAtPlanGate([makeBriefQualityFailureTask()]);
    const repaired = { ...makePassingTask(), title: 'Repaired brief' };
    const review = vi.fn().mockResolvedValue({ text: formatTasks([repaired]), usage: null });

    const { result } = await continueParked({
      sessionId,
      state,
      planner: makePassingPlanner({ review }),
      approve,
    });

    expect(review).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      disposition: 'ready-for-tasks',
      state: { phase: 'implementing', tasks: [{ title: 'Repaired brief' }] },
      tasks: [{ title: 'Repaired brief' }],
    });
    expect(loadState({ projectDir, sessionId })).toMatchObject({
      phase: 'implementing',
      tasks: [{ title: 'Repaired brief' }],
    });
  },
);

it('admits the briefs with no briefs gate when the approval level changed to none', async () => {
  const { sessionId, state } = parkAtPlanGate([makePassingTask()]);

  const { result, briefsPrompts, verdicts } = await continueParked({
    sessionId,
    state,
    planner: makePassingPlanner(),
    approve: 'none',
  });

  expect(briefsPrompts).toEqual([]);
  expect(verdicts).toEqual(['brief_quality_passed']);
  expect(result).toMatchObject({
    disposition: 'ready-for-tasks',
    state: { phase: 'implementing' },
  });
});

it.each(['edit', 'revise'] as const)(
  'persists accepted briefs after %s at a resumed briefs gate',
  async (action) => {
    const { sessionId, state } = parkAtPlanGate([makePassingTask()]);
    const accepted = { ...makePassingTask(), title: 'Accepted brief' };
    const review = vi.fn().mockResolvedValue({ text: formatTasks([accepted]), usage: null });
    let prompts = 0;
    const result = await resumeParkedApproval({
      wctx: makeWctx({
        projectDir,
        sessionId,
        planner: makePassingPlanner({ review }),
        config: makeConfig({ workflow: { mode: 'standard', approve: 'all' } }),
        callbacks: makeCallbacks({
          onApprovalNeeded: async () => {
            if (prompts++ > 0) return { approved: true };
            if (action === 'edit') {
              writeFileSync(
                join(sessionDir(projectDir, sessionId), TASKS_FILE),
                formatTasks([accepted]),
              );
              return { approved: false, action: 'edit' };
            }
            return { approved: false, action: 'revise', comment: 'Use the accepted brief title' };
          },
        }).callbacks,
      }),
      state: { ...state, phase: 'reviewing-briefs' },
      setTrackedState: () => {},
      phaseTimings: {},
      startTime: Date.now(),
    });

    expect(prompts).toBe(2);
    expect(review).toHaveBeenCalledTimes(action === 'revise' ? 1 : 0);
    expect(result).toMatchObject({
      disposition: 'ready-for-tasks',
      state: { phase: 'implementing', tasks: [{ title: 'Accepted brief' }] },
      tasks: [{ title: 'Accepted brief' }],
    });
    expect(loadState({ projectDir, sessionId })).toMatchObject({
      phase: 'implementing',
      tasks: [{ title: 'Accepted brief' }],
    });
  },
);

it("revises at a resumed briefs gate with the run's skills context", async () => {
  const { sessionId, state } = parkAtPlanGate([makePassingTask()]);
  const skillsContext = '## Active Project Skills\n\n### AuthSkill\nRESUME-SKILL-BODY';
  const review = vi.fn().mockResolvedValue({ text: formatTasks([makePassingTask()]), usage: null });
  let prompts = 0;

  await resumeParkedApproval({
    wctx: makeWctx({
      projectDir,
      sessionId,
      planner: makePassingPlanner({ review }),
      config: makeConfig({ workflow: { mode: 'standard', approve: 'all' } }),
      context: { ...defaultContext, dir: projectDir, skillsContext },
      callbacks: makeCallbacks({
        onApprovalNeeded: async () =>
          prompts++ > 0
            ? { approved: true }
            : { approved: false, action: 'revise', comment: 'narrow the scope' },
      }).callbacks,
    }),
    state: { ...state, phase: 'reviewing-briefs' },
    setTrackedState: () => {},
    phaseTimings: {},
    startTime: Date.now(),
  });

  expect(review).toHaveBeenCalledWith(
    expect.stringContaining(skillsContext),
    expect.anything(),
    expect.anything(),
  );
});

it('checks a legacy run before briefs review without replacing persisted planning artifacts', async () => {
  const parked = parkAtPlanGate([makePassingTask()]);
  const { mode: _mode, approve: _approve, ...legacy } = parked.state;
  const state = transition(legacy, {
    type: 'INTERRUPT_STEP',
    step: { kind: 'gate', gate: 'plan' },
    source: 'user',
    cut: 'mid-step',
  });
  const { sessionId } = parked;
  saveState({ projectDir, sessionId }, state);
  const dir = sessionDir(projectDir, sessionId);
  const files = [RESEARCH_FILE, SPEC_FILE, PLAN_FILE, TASKS_FILE];
  const artifacts = files.map((file) => readFileSync(join(dir, file), 'utf8'));
  const recorder = makeBusRecorder();
  const planner = makePassingPlanner();
  const runPhase = vi.spyOn(planner, 'runPhase');
  const review = vi.spyOn(planner, 'review');
  const prompts: Array<{ gate: string; verdicts: string[] }> = [];
  const artifactsAtBriefs: string[][] = [];
  const result = await runPlanningPhases({
    wctx: makeWctx({
      projectDir,
      sessionId,
      planner,
      bus: recorder.bus,
      config: makeConfig({ workflow: { mode: 'standard', approve: 'all' } }),
      callbacks: makeCallbacks({
        onApprovalNeeded: async (gate) => {
          prompts.push({ gate, verdicts: qualityVerdicts(recorder.events) });
          if (gate === 'briefs') {
            artifactsAtBriefs.push(files.map((file) => readFileSync(join(dir, file), 'utf8')));
          }
          return { approved: true };
        },
      }).callbacks,
    }),
    state,
    savedState: state,
    phaseTimings: {},
    startTime: Date.now(),
    setTrackedState: () => {},
  });

  expect(prompts).toEqual([
    { gate: 'plan', verdicts: [] },
    { gate: 'briefs', verdicts: ['brief_quality_passed'] },
  ]);
  expect(result).toMatchObject({
    disposition: 'ready-for-tasks',
    state: { phase: 'implementing', mode: 'standard', approve: 'all' },
  });
  expect(runPhase).not.toHaveBeenCalled();
  expect(review).not.toHaveBeenCalled();
  expect(artifactsAtBriefs).toEqual([artifacts]);
  expect(files.slice(0, 3).map((file) => readFileSync(join(dir, file), 'utf8'))).toEqual(
    artifacts.slice(0, 3),
  );
  expect(qualityVerdicts(recorder.events)).toEqual(['brief_quality_passed']);
});

it('halts after bounded quality repair when a resumed plan has no briefs gate', async () => {
  const failing = makeBriefQualityFailureTask();
  const { sessionId, state } = parkAtPlanGate([failing]);
  const review = vi.fn().mockResolvedValue({ text: formatTasks([failing]), usage: null });
  const { result, briefsPrompts, verdicts } = await continueParked({
    sessionId,
    state,
    planner: makePassingPlanner({ review }),
    approve: 'none',
  });

  expect(briefsPrompts).toEqual([]);
  expect(review).toHaveBeenCalledTimes(2);
  expect(verdicts).toEqual([
    'brief_quality_failed',
    'brief_quality_failed',
    'brief_quality_failed',
  ]);
  expect(result).toMatchObject({
    disposition: 'terminal',
    outcome: 'halted',
    state: { pendingRecovery: { reason: 'brief-quality-unrepaired' } },
  });
  expect(loadState({ projectDir, sessionId })?.pendingRecovery?.reason).toBe(
    'brief-quality-unrepaired',
  );
  expect(loadState({ projectDir, sessionId })?.phase).not.toBe('implementing');
});

it('rechecks an edited parked spec before generating its plan or briefs', async () => {
  projectDir = createTempDir('parked-spec-approval');
  const sessionId = 'sess-parked-spec';
  ensureSessionDir(projectDir, sessionId);
  const dir = sessionDir(projectDir, sessionId);
  mkdirSync(join(projectDir, '.specify', 'memory'), { recursive: true });
  writeFileSync(join(projectDir, '.specify', 'memory', 'constitution.md'), '# One slice only\n');
  for (const file of [RESEARCH_FILE, SPEC_FILE, CLARIFICATIONS_FILE, PLAN_FILE, TASKS_FILE]) {
    writeFileSync(join(dir, file), '# Old artifact\n');
  }
  writeFileSync(join(dir, CONSTITUTION_CHECK_FILE), '{"passed":true,"violations":[]}');
  const calls: string[] = [];
  const reviews: string[] = [];
  const planner = makePlanner({
    runPhase: async ({ call }) => {
      calls.push(call);
      return makePhaseCallResult({ call });
    },
    review: async (prompt) => {
      reviews.push(prompt);
      return {
        text: JSON.stringify({
          passed: false,
          violations: [{ principle: 'one-slice', reason: 'too broad', severity: 'hard' }],
        }),
        usage: null,
      };
    },
  });
  let approvals = 0;
  const state: WorkflowState = {
    ...createInitialState('feature'),
    phase: 'reviewing-spec',
    mode: 'speckit',
    approve: 'spec',
  };
  let tracked = state;
  const result = await resumeParkedApproval({
    wctx: makeWctx({
      projectDir,
      sessionId,
      planner,
      config: makeConfig({ workflow: { mode: 'speckit', approve: 'spec' } }),
      callbacks: makeCallbacks({
        onApprovalNeeded: async () => {
          approvals += 1;
          writeFileSync(join(dir, SPEC_FILE), '# Revised spec\n\nRequirement B\n');
          return { approved: true };
        },
      }).callbacks,
    }),
    state,
    setTrackedState: (next) => {
      tracked = next;
    },
    phaseTimings: {},
    startTime: Date.now(),
  });

  expect(result).toMatchObject({ disposition: 'terminal', outcome: 'halted' });
  expect(tracked.phase).toBe('constitution-check');
  expect(reviews).toHaveLength(1);
  expect(reviews[0]).toContain('Requirement B');
  expect(calls).toEqual([]);
  expect(approvals).toBe(1);
  expect(readFileSync(join(dir, SPEC_FILE), 'utf8')).toContain('Requirement B');
  expect(JSON.parse(readFileSync(join(dir, CONSTITUTION_CHECK_FILE), 'utf8'))).toMatchObject({
    passed: false,
  });
  expect(existsSync(join(dir, PLAN_FILE))).toBe(false);
  expect(existsSync(join(dir, TASKS_FILE))).toBe(false);
});
