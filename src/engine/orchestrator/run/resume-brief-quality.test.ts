import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeNoValidationConfig, defaultContext } from '#testing/helpers/factories/config.js';
import {
  makeBusRecorder,
  makeCallbacks,
  makeCopyingIsolation,
  makeImplementer,
  makePlanner,
  TEST_METADATA,
} from '#testing/helpers/orchestrator-factories.js';
import { REAL_TASKS_MD } from '#testing/helpers/planning-phase.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { setupGitSessionProject } from '#testing/helpers/git-session.js';
import { TASKS_FILE } from '../../../core/paths.js';
import { writeSpecFile } from '../../../core/paths-io.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { createInitialState } from '../../../core/state/machine.js';
import type { OrchestratorCallbacks, WorkflowContext, WorkflowSinks } from '../types.js';
import { createValidator } from '../validation/run.js';
import { runPlanningPhases } from './phases.js';

const TEST_SINKS: WorkflowSinks = {
  setAbortHandler: () => {},
  setQueueHandler: () => {},
};

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) cleanupTempDir(dir);
  dirs = [];
});

function setupProject(): { projectDir: string; sessionId: string } {
  const project = setupGitSessionProject({
    prefix: 'resume-brief-quality-test',
    sessionId: 'sess-resume-brief-quality',
  });
  dirs.push(project.projectDir);
  return project;
}

function makeResumeWctx(opts: {
  projectDir: string;
  sessionId: string;
  callbacks: OrchestratorCallbacks;
  bus: ReturnType<typeof makeBusRecorder>['bus'];
  planner: ReturnType<typeof makePlanner>;
}): WorkflowContext {
  return {
    projectDir: opts.projectDir,
    sessionId: opts.sessionId,
    isolation: makeCopyingIsolation({
      projectDir: opts.projectDir,
      sessionId: opts.sessionId,
    }),
    config: makeNoValidationConfig({ workflow: { approve: 'all' } }),
    callbacks: opts.callbacks,
    bus: opts.bus,
    planner: opts.planner,
    reviewer: opts.planner,
    context: defaultContext,
    implementer: makeImplementer(),
    metadata: TEST_METADATA,
    sinks: TEST_SINKS,
    validator: createValidator(),
  };
}

function parkedState(phase: 'reviewing-plan' | 'reviewing-briefs'): WorkflowState {
  return { ...createInitialState('feature'), phase };
}

describe('resumed planning brief-quality admission', () => {
  it('does not replay parked Brief Review without an owner-supplied recovery projection', async () => {
    const { projectDir, sessionId } = setupProject();
    const planner = makePlanner({ review: vi.fn() });
    const onApprovalNeeded = vi.fn<OrchestratorCallbacks['onApprovalNeeded']>().mockResolvedValue({
      approved: true,
    });
    const { callbacks } = makeCallbacks({ onApprovalNeeded });
    const { bus, events } = makeBusRecorder();
    const state = parkedState('reviewing-briefs');

    const result = await runPlanningPhases({
      wctx: makeResumeWctx({ projectDir, sessionId, callbacks, bus, planner }),
      state,
      savedState: state,
      selectedSkills: undefined,
      phaseTimings: {},
      startTime: Date.now(),
      setTrackedState: vi.fn(),
    });

    expect(result).toMatchObject({ disposition: 'parked', state: { phase: 'reviewing-briefs' } });
    expect(onApprovalNeeded).not.toHaveBeenCalled();
    expect(planner.review).not.toHaveBeenCalled();
    expect(events.some((event) => event.type === 'brief_quality_failed')).toBe(false);
  });

  it('does not inspect persisted tasks or invoke a provider while the owner projection is absent', async () => {
    const { projectDir, sessionId } = setupProject();
    writeSpecFile({ projectDir, sessionId }, TASKS_FILE, REAL_TASKS_MD, TEST_METADATA);
    const planner = makePlanner();
    const onApprovalNeeded = vi.fn<OrchestratorCallbacks['onApprovalNeeded']>().mockResolvedValue({
      approved: true,
    });
    const { callbacks } = makeCallbacks({ onApprovalNeeded });
    const { bus, events } = makeBusRecorder();
    const state = parkedState('reviewing-briefs');

    const result = await runPlanningPhases({
      wctx: makeResumeWctx({ projectDir, sessionId, callbacks, bus, planner }),
      state,
      savedState: state,
      selectedSkills: undefined,
      phaseTimings: {},
      startTime: Date.now(),
      setTrackedState: vi.fn(),
    });

    expect(result).toMatchObject({ disposition: 'parked', state: { phase: 'reviewing-briefs' } });
    expect(onApprovalNeeded).not.toHaveBeenCalled();
    expect(planner.review).not.toHaveBeenCalled();
    expect(events.filter((event) => event.type === 'brief_quality_passed')).toHaveLength(0);
  });
});
