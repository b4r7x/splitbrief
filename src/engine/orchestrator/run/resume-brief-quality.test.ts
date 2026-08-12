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
import { makeBriefQualityFailureTask, REAL_TASKS_MD } from '#testing/helpers/planning-phase.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { setupGitSessionProject } from '#testing/helpers/git-session.js';
import { PLAN_FILE, TASKS_FILE, sessionDir } from '../../../core/paths.js';
import { writeSpecFile } from '../../../core/paths-io.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
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
    context: defaultContext,
    implementer: makeImplementer(),
    metadata: TEST_METADATA,
    sinks: TEST_SINKS,
    validator: createValidator(),
  };
}

function parkedState(phase: 'reviewing-plan' | 'reviewing-briefs'): WorkflowState {
  return { ...makeImplState([]), phase };
}

describe('resumed planning brief-quality admission', () => {
  it('fails closed before briefs approval when a resumed plan produces invalid Task Briefs', async () => {
    const { projectDir, sessionId } = setupProject();
    writeSpecFile({ projectDir, sessionId }, PLAN_FILE, '# Approved plan', TEST_METADATA);
    const planner = makePlanner({
      review: vi.fn().mockResolvedValue({ text: 'planner prose, not Task Briefs', usage: null }),
    });
    const onApprovalNeeded = vi.fn<OrchestratorCallbacks['onApprovalNeeded']>().mockResolvedValue({
      approved: true,
    });
    const { callbacks } = makeCallbacks({ onApprovalNeeded });
    const { bus, events } = makeBusRecorder();
    const state = {
      ...parkedState('reviewing-plan'),
      tasks: [makeBriefQualityFailureTask()],
    };

    const result = await runPlanningPhases({
      wctx: makeResumeWctx({ projectDir, sessionId, callbacks, bus, planner }),
      state,
      savedState: state,
      selectedSkills: undefined,
      phaseTimings: {},
      startTime: Date.now(),
      setTrackedState: vi.fn(),
    });

    expect(result).toMatchObject({ cancelled: true, failed: true, state: { phase: 'idle' } });
    expect(onApprovalNeeded).toHaveBeenCalledTimes(1);
    expect(onApprovalNeeded).toHaveBeenCalledWith(
      'plan',
      `${sessionDir(projectDir, sessionId)}/${PLAN_FILE}`,
    );
    expect(events.filter((event) => event.type === 'brief_quality_failed')).toHaveLength(2);
    expect(events.some((event) => event.type === 'error')).toBe(true);
  });

  it('keeps an already parked briefs review on the normal approval path', async () => {
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

    expect(result).toMatchObject({
      cancelled: false,
      failed: false,
      state: { phase: 'implementing' },
    });
    expect(onApprovalNeeded).toHaveBeenCalledTimes(1);
    expect(onApprovalNeeded).toHaveBeenCalledWith(
      'briefs',
      `${sessionDir(projectDir, sessionId)}/${TASKS_FILE}`,
    );
    expect(events.filter((event) => event.type === 'brief_quality_passed')).toHaveLength(1);
  });
});
