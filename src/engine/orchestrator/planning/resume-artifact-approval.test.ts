import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  makeBusRecorder,
  makeCallbacks,
  makePlanner,
  TEST_METADATA,
} from '#testing/helpers/orchestrator-factories.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { createInitialState } from '../../../core/state/machine.js';
import { PLAN_FILE, SPEC_FILE, sessionDir } from '../../../core/paths.js';
import { writeSpecFile } from '../../../core/paths-io.js';
import type { PlannerCallbacksContext } from '../types.js';
import type { EventBus } from '../../events/types.js';
import type { OrchestratorCallbacks } from '../types.js';
import type { Planner } from '../../planners/types.js';
import { resumeArtifactApproval } from './resume-artifact-approval.js';

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) cleanupTempDir(dir);
  dirs = [];
});

function setupProject(): { projectDir: string; sessionId: string } {
  const projectDir = createTempDir('resume-artifact-test');
  dirs.push(projectDir);
  return { projectDir, sessionId: 'sess-resume-artifact' };
}

function makeWctx(opts: {
  projectDir: string;
  sessionId: string;
  callbacks: OrchestratorCallbacks;
  bus: EventBus;
  config?: ReturnType<typeof makeConfig>;
  planner?: Planner;
}): PlannerCallbacksContext & { planner: Planner } {
  return {
    projectDir: opts.projectDir,
    sessionId: opts.sessionId,
    config: opts.config ?? makeConfig({ workflow: { mode: 'standard' } }),
    callbacks: opts.callbacks,
    bus: opts.bus,
    metadata: TEST_METADATA,
    sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
    planner: opts.planner ?? makePlanner(),
  };
}

function parkedState(phase: 'reviewing-spec' | 'reviewing-plan'): WorkflowState {
  return { ...createInitialState('feature'), phase };
}

describe('resumeArtifactApproval', () => {
  it('resumes a reviewing-spec session into the spec approval prompt over the persisted spec.md', async () => {
    const { projectDir, sessionId } = setupProject();
    writeSpecFile({ projectDir, sessionId }, SPEC_FILE, '# Spec', TEST_METADATA);
    const onApprovalNeeded = vi
      .fn<OrchestratorCallbacks['onApprovalNeeded']>()
      .mockResolvedValue({ approved: true });
    const { callbacks } = makeCallbacks({ onApprovalNeeded });
    const { bus } = makeBusRecorder();

    const result = await resumeArtifactApproval({
      wctx: makeWctx({ projectDir, sessionId, callbacks, bus }),
      state: parkedState('reviewing-spec'),
      phase: 'reviewing-spec',
    });

    expect(result.cancelled).toBe(false);
    expect(result.regenerated).toBe(false);
    expect(result.state.phase).toBe('reviewing-spec');
    expect(onApprovalNeeded).toHaveBeenCalledTimes(1);
    expect(onApprovalNeeded).toHaveBeenCalledWith(
      'spec',
      join(sessionDir(projectDir, sessionId), SPEC_FILE),
    );
  });

  it('calls the planner on a revise and re-shows the prompt over the revised artifact', async () => {
    const { projectDir, sessionId } = setupProject();
    writeSpecFile({ projectDir, sessionId }, SPEC_FILE, '# Spec', TEST_METADATA);
    const prompts: string[] = [];
    const regenerate = vi.fn().mockImplementation(async ({ prompt }: { prompt: string }) => {
      prompts.push(prompt);
      return { text: '# Revised spec', usage: null };
    });
    const onApprovalNeeded = vi
      .fn<OrchestratorCallbacks['onApprovalNeeded']>()
      .mockResolvedValueOnce({ approved: false, action: 'revise', comment: 'more detail' })
      .mockResolvedValueOnce({ approved: true });
    const { callbacks } = makeCallbacks({ onApprovalNeeded });
    const { bus, events } = makeBusRecorder();

    const result = await resumeArtifactApproval({
      wctx: makeWctx({
        projectDir,
        sessionId,
        callbacks,
        bus,
        planner: makePlanner({ regenerate }),
      }),
      state: parkedState('reviewing-spec'),
      phase: 'reviewing-spec',
    });

    expect(result.cancelled).toBe(false);
    // the caller must know the artifact changed so it can regenerate what the revision invalidated
    expect(result.regenerated).toBe(true);
    expect(onApprovalNeeded).toHaveBeenCalledTimes(2);
    expect(regenerate).toHaveBeenCalledTimes(1);
    expect(prompts[0]).toContain('more detail');
    expect(events.some((event) => event.type === 'spec_regenerated')).toBe(true);
    const revised = readFileSync(join(sessionDir(projectDir, sessionId), SPEC_FILE), 'utf8');
    expect(revised).toContain('# Revised spec');
  });

  it('fails with the coded error when the artifact is missing', async () => {
    const { projectDir, sessionId } = setupProject();
    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();

    const result = await resumeArtifactApproval({
      wctx: makeWctx({ projectDir, sessionId, callbacks, bus }),
      state: parkedState('reviewing-spec'),
      phase: 'reviewing-spec',
    });

    expect(result.cancelled).toBe(true);
    const error = events.find((event) => event.type === 'error');
    expect(error).toMatchObject({ code: 'artifact_not_restorable' });
    expect(error?.message).toContain('spec.md');
    expect(callbacks.onApprovalNeeded).not.toHaveBeenCalled();
  });

  it('derives the effective approval level from the current config, not the persisted state', async () => {
    const { projectDir, sessionId } = setupProject();
    writeSpecFile({ projectDir, sessionId }, SPEC_FILE, '# Spec', TEST_METADATA);
    const { callbacks } = makeCallbacks();
    const { bus } = makeBusRecorder();
    const none = makeConfig({ workflow: { mode: 'standard', approve: 'none' } });

    const skipped = await resumeArtifactApproval({
      wctx: makeWctx({ projectDir, sessionId, callbacks, bus, config: none }),
      state: { ...parkedState('reviewing-spec'), approve: 'all' },
      phase: 'reviewing-spec',
    });

    expect(skipped.cancelled).toBe(false);
    expect(callbacks.onApprovalNeeded).not.toHaveBeenCalled();

    const all = makeConfig({ workflow: { mode: 'standard', approve: 'all' } });
    const onApprovalNeeded = vi
      .fn<OrchestratorCallbacks['onApprovalNeeded']>()
      .mockResolvedValue({ approved: true });
    const { callbacks: blocking } = makeCallbacks({ onApprovalNeeded });

    const prompted = await resumeArtifactApproval({
      wctx: makeWctx({ projectDir, sessionId, callbacks: blocking, bus, config: all }),
      state: { ...parkedState('reviewing-spec'), approve: 'none' },
      phase: 'reviewing-spec',
    });

    expect(prompted.cancelled).toBe(false);
    expect(onApprovalNeeded).toHaveBeenCalledTimes(1);
  });

  it('resumes a reviewing-plan session over plan.md', async () => {
    const { projectDir, sessionId } = setupProject();
    writeSpecFile({ projectDir, sessionId }, PLAN_FILE, '# Plan', TEST_METADATA);
    const onApprovalNeeded = vi
      .fn<OrchestratorCallbacks['onApprovalNeeded']>()
      .mockResolvedValue({ approved: true });
    const { callbacks } = makeCallbacks({ onApprovalNeeded });
    const { bus } = makeBusRecorder();
    const config = makeConfig({ workflow: { mode: 'standard', approve: 'all' } });

    const result = await resumeArtifactApproval({
      wctx: makeWctx({ projectDir, sessionId, callbacks, bus, config }),
      state: parkedState('reviewing-plan'),
      phase: 'reviewing-plan',
    });

    expect(result.cancelled).toBe(false);
    expect(result.state.phase).toBe('reviewing-plan');
    expect(onApprovalNeeded).toHaveBeenCalledTimes(1);
    expect(onApprovalNeeded).toHaveBeenCalledWith(
      'plan',
      join(sessionDir(projectDir, sessionId), PLAN_FILE),
    );
  });
});
