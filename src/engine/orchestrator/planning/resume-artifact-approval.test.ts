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
  skillsContext?: string;
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
    ...(opts.skillsContext !== undefined && { skillsContext: opts.skillsContext }),
  };
}

function parkedState(phase: 'reviewing-spec' | 'reviewing-plan'): WorkflowState {
  return { ...createInitialState('feature'), phase };
}

describe('resumeArtifactApproval', () => {
  it.each(['reviewing-spec', 'reviewing-plan'] as const)(
    'does not invent a missing artifact or gate for a saved quick run in %s',
    async (phase) => {
      const { projectDir, sessionId } = setupProject();
      const { callbacks } = makeCallbacks();
      const { bus, events } = makeBusRecorder();
      const planner = makePlanner();
      const result = await resumeArtifactApproval({
        wctx: makeWctx({
          projectDir,
          sessionId,
          callbacks,
          bus,
          planner,
          config: makeConfig({ workflow: { mode: 'speckit', approve: 'all' } }),
        }),
        state: { ...parkedState(phase), mode: 'quick', approve: 'all' },
        phase,
      });
      expect(result.cancelled).toBe(false);
      expect(result.state.mode).toBe('quick');
      expect(callbacks.onApprovalNeeded).not.toHaveBeenCalled();
      expect(planner.runPhase).not.toHaveBeenCalled();
      expect(events.filter((event) => event.type === 'error')).toEqual([]);
    },
  );

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

  it("revises a resumed spec gate with the run's skills context", async () => {
    const { projectDir, sessionId } = setupProject();
    writeSpecFile({ projectDir, sessionId }, SPEC_FILE, '# Spec', TEST_METADATA);
    const skillsContext = '## Active Project Skills\n\n### AuthSkill\nRESUME-SKILL-BODY';
    const regenerate = vi.fn().mockResolvedValue({ text: '# Revised spec', usage: null });
    const onApprovalNeeded = vi
      .fn<OrchestratorCallbacks['onApprovalNeeded']>()
      .mockResolvedValueOnce({ approved: false, action: 'revise', comment: 'more detail' })
      .mockResolvedValueOnce({ approved: true });
    const { callbacks } = makeCallbacks({ onApprovalNeeded });

    await resumeArtifactApproval({
      wctx: makeWctx({
        projectDir,
        sessionId,
        callbacks,
        bus: makeBusRecorder().bus,
        planner: makePlanner({ regenerate }),
        skillsContext,
      }),
      state: parkedState('reviewing-spec'),
      phase: 'reviewing-spec',
    });

    expect(regenerate).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: expect.stringContaining(skillsContext) }),
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

  // The saved level applies only while the config leaves `workflow.approve` at its default
  // (`resolveApproveLevel`).
  it('lets an approval level the config names outrank the saved one', async () => {
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

  // Quick has no spec or plan gate, so only the two modes that park at one are listed.
  it.each([
    ['standard', 'none', 'reviewing-spec', false],
    ['standard', 'spec', 'reviewing-spec', true],
    ['standard', 'plan', 'reviewing-spec', false],
    ['standard', 'all', 'reviewing-spec', true],
    ['standard', 'none', 'reviewing-plan', false],
    ['standard', 'spec', 'reviewing-plan', false],
    ['standard', 'plan', 'reviewing-plan', true],
    ['standard', 'all', 'reviewing-plan', true],
    ['speckit', 'none', 'reviewing-spec', false],
    ['speckit', 'spec', 'reviewing-spec', true],
    ['speckit', 'plan', 'reviewing-spec', false],
    ['speckit', 'all', 'reviewing-spec', true],
    ['speckit', 'none', 'reviewing-plan', false],
    ['speckit', 'spec', 'reviewing-plan', false],
    ['speckit', 'plan', 'reviewing-plan', true],
    ['speckit', 'all', 'reviewing-plan', true],
  ] as const)(
    'resumes a %s run saved with approve %s in %s at its own level under a quick config (opens: %s)',
    async (mode, approve, phase, opens) => {
      const { projectDir, sessionId } = setupProject();
      const ref = { projectDir, sessionId };
      writeSpecFile(
        ref,
        phase === 'reviewing-spec' ? SPEC_FILE : PLAN_FILE,
        '# Doc',
        TEST_METADATA,
      );
      const onApprovalNeeded = vi
        .fn<OrchestratorCallbacks['onApprovalNeeded']>()
        .mockResolvedValue({ approved: true });
      const { callbacks } = makeCallbacks({ onApprovalNeeded });
      const { bus } = makeBusRecorder();
      const config = makeConfig({ workflow: { mode: 'quick' } });

      const result = await resumeArtifactApproval({
        wctx: makeWctx({ projectDir, sessionId, callbacks, bus, config }),
        state: { ...parkedState(phase), mode, approve },
        phase,
      });

      expect(onApprovalNeeded).toHaveBeenCalledTimes(opens ? 1 : 0);
      expect(result).toMatchObject({ cancelled: false, closed: false, state: { mode, approve } });
    },
  );

  // The steps after the gate read the pair from this state, so a state that saved none carries the
  // pair the gate was decided by, not a fallback of its own.
  it('hands on the mode and level it resolved for a state that saved neither', async () => {
    const { projectDir, sessionId } = setupProject();
    writeSpecFile({ projectDir, sessionId }, SPEC_FILE, '# Spec', TEST_METADATA);
    const onApprovalNeeded = vi
      .fn<OrchestratorCallbacks['onApprovalNeeded']>()
      .mockResolvedValue({ approved: true });
    const { callbacks } = makeCallbacks({ onApprovalNeeded });
    const { bus } = makeBusRecorder();
    const config = makeConfig({ workflow: { mode: 'speckit' } });

    const result = await resumeArtifactApproval({
      wctx: makeWctx({ projectDir, sessionId, callbacks, bus, config }),
      state: parkedState('reviewing-spec'),
      phase: 'reviewing-spec',
    });

    expect(onApprovalNeeded).toHaveBeenCalledTimes(1);
    expect(result.state).toMatchObject({ mode: 'speckit', approve: 'all' });
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
