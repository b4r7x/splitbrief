import { describe, it, expect, vi, afterEach } from 'vitest';
import { createInitialState } from '../../../core/state/machine.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeCallbacks } from '#testing/helpers/orchestrator-factories.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { PLAN_FILE, SPEC_FILE } from '../../../core/paths.js';
import { writeSpecFile } from '../../../core/paths-io.js';
import { appendMessage } from '../../../core/sessions/log-writer.js';
import { loadState } from '../../../core/state/persistence.js';
import type { OrchestratorCallbacks } from '../types.js';
import type { Config } from '../../../core/schemas/config.js';
import type { ApprovalReviewResult } from '../../../core/approval/types.js';
import type { RunPhaseInput } from '../../planners/types.js';
import { makePhaseCallResult } from '#testing/helpers/factories/phase-call.js';
import {
  REAL_TASKS_MD,
  setupProject,
  makePassingTask,
  makePassingPlanner,
  makeExpiredThreadPlanner,
  makeRecordingPlanner,
  prepareState,
  sequencedApproval,
  auto,
  manual,
  runOwnedPlanningPhase,
  type OwnedRunOpts,
} from '#testing/helpers/planning-phase.js';

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) cleanupTempDir(d);
  dirs = [];
});

function runPhase(opts: OwnedRunOpts = {}) {
  return runOwnedPlanningPhase(dirs, opts);
}

describe('runPlanningPhase — happy paths (modes + approval)', () => {
  const happyCases: Array<{
    name: string;
    workflow: Partial<Config['workflow']>;
    approvals?: readonly ApprovalReviewResult[];
    useQuickPlan?: boolean;
  }> = [
    { name: 'auto-approve both completes without user interaction', workflow: auto() },
    {
      name: 'quick mode skips approval and uses quickPlan',
      workflow: manual('quick'),
      useQuickPlan: true,
    },
    {
      name: 'standard mode uses spec + briefs approval gates',
      workflow: manual('standard'),
      approvals: [{ approved: true }, { approved: true }],
    },
    {
      name: 'speckit mode requires spec + plan + briefs approvals',
      workflow: manual('speckit'),
      approvals: [{ approved: true }, { approved: true }, { approved: true }],
    },
  ] as const;

  it.each(happyCases)('$name', async ({ workflow, approvals, useQuickPlan }) => {
    const onApprovalNeeded = approvals ? sequencedApproval(approvals) : undefined;
    const { callbacks } = makeCallbacks(onApprovalNeeded ? { onApprovalNeeded } : undefined);
    // Distinctive task id lets us verify the quick tasks call flowed through.
    const calls: string[] = [];
    const phaseRunner = useQuickPlan
      ? vi.fn(async ({ call }: RunPhaseInput) => {
          calls.push(call);
          return makePhaseCallResult({
            call,
            usage: { inputTokens: 50, outputTokens: 25 },
            ...(call === 'tasks' ? { tasks: [makePassingTask('T099')] } : {}),
          });
        })
      : undefined;
    const planner = makePassingPlanner(phaseRunner ? { runPhase: phaseRunner } : undefined);

    const { result } = await runPhase({ planner, callbacks, config: makeConfig({ workflow }) });

    expect(result.disposition).toBe('ready-for-tasks');
    expect(result.tasks).toHaveLength(1);
    expect(result.state.phase).toBe('implementing');
    if (useQuickPlan) {
      expect(calls).toEqual(['tasks']);
      expect(result.tasks[0]?.id).toBe('T099');
    }
  });

  it('skipping the briefs approval loop still reaches implementing', async () => {
    const { callbacks } = makeCallbacks();
    const planner = makePassingPlanner();

    const { result } = await runPhase({
      planner,
      callbacks,
      config: makeConfig({ workflow: auto('standard') }),
    });

    expect(result.disposition).toBe('ready-for-tasks');
    expect(result.state.phase).toBe('implementing');
  });

  it('user comment → spec regenerated, workflow completes', async () => {
    const onApprovalNeeded = sequencedApproval([
      { approved: false, action: 'revise', comment: 'add auth section' },
      { approved: true },
      { approved: true },
    ]);
    const { callbacks } = makeCallbacks({ onApprovalNeeded });
    // The gate's comment goes to planner.regenerate; the revised spec then
    // invalidates the plan and the briefs, which the step loop compiles again.
    const regenArgs: Array<{ prompt: string }> = [];
    const planner = makePassingPlanner({
      review: vi.fn().mockResolvedValue({ text: REAL_TASKS_MD, usage: null }),
      regenerate: async (opts) => {
        regenArgs.push({ prompt: opts.prompt });
        return { text: '# Regenerated Spec\n\nauth section added.\n', usage: null };
      },
    });

    const { result } = await runPhase({
      planner,
      callbacks,
      config: makeConfig({ workflow: manual() }),
    });

    expect(result.disposition).toBe('ready-for-tasks');
    expect(result.tasks).toHaveLength(1);
    expect(result.state.phase).toBe('implementing');
    expect(regenArgs).toHaveLength(1);
    expect(regenArgs[0]?.prompt).toContain('add auth section');
    expect(regenArgs[0]?.prompt).toContain('spec');
  });

  it("regenerates at the spec gate and the briefs gate with the run's skills context", async () => {
    const skillsContext = '## Active Project Skills\n\n### AuthSkill\nGATE-SKILL-BODY';
    const onApprovalNeeded = sequencedApproval([
      { approved: false, action: 'revise', comment: 'add auth section' },
      { approved: true },
      { approved: false, action: 'revise', comment: 'narrow the scope' },
      { approved: true },
    ]);
    const { callbacks } = makeCallbacks({ onApprovalNeeded });
    const regeneratePrompts: string[] = [];
    const reviewPrompts: string[] = [];
    const planner = makePassingPlanner({
      review: async (prompt: string) => {
        reviewPrompts.push(prompt);
        return { text: REAL_TASKS_MD, usage: null };
      },
      regenerate: async (opts) => {
        regeneratePrompts.push(opts.prompt);
        return { text: '# Regenerated Spec\n\nauth section added.\n', usage: null };
      },
    });

    const { result } = await runPhase({
      planner,
      callbacks,
      config: makeConfig({ workflow: manual('standard') }),
      skillsContext,
    });

    expect(result.disposition).toBe('ready-for-tasks');
    expect(regeneratePrompts).toEqual([expect.stringContaining(skillsContext)]);
    expect(reviewPrompts).toEqual([expect.stringContaining(skillsContext)]);
  });

  it('spec gate: editing spec.md on disk then approving regenerates plan and tasks from the edit', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const { planner, calls } = makeRecordingPlanner();
    const onApprovalNeeded = vi
      .fn<OrchestratorCallbacks['onApprovalNeeded']>()
      .mockImplementationOnce(async () => {
        writeSpecFile({ projectDir, sessionId }, SPEC_FILE, '# Spec\n\nUser-edited auth.\n', null);
        return { approved: true };
      })
      .mockResolvedValueOnce({ approved: true });
    const { callbacks } = makeCallbacks({ onApprovalNeeded });
    const config = makeConfig({ workflow: manual('standard') });

    const { result } = await runPhase({
      project: { projectDir, sessionId },
      planner,
      callbacks,
      config,
      state: { ...createInitialState('feature'), phase: 'idle' },
      feature: 'feature',
    });

    expect(result.disposition).toBe('ready-for-tasks');
    expect(result.state.phase).toBe('implementing');
    const replanned = calls.filter((entry) => entry.call === 'plan');
    expect(replanned.at(-1)?.inputs.spec).toContain('User-edited auth.');
  });

  it('plan gate: editing plan.md on disk then approving regenerates tasks from the edit', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const { planner, calls } = makeRecordingPlanner();
    const onApprovalNeeded = vi
      .fn<OrchestratorCallbacks['onApprovalNeeded']>()
      .mockResolvedValueOnce({ approved: true })
      .mockImplementationOnce(async () => {
        writeSpecFile(
          { projectDir, sessionId },
          PLAN_FILE,
          '# Plan\n\nUser-edited JWT plan.\n',
          null,
        );
        return { approved: true };
      })
      .mockResolvedValueOnce({ approved: true });
    const { callbacks } = makeCallbacks({ onApprovalNeeded });
    const config = makeConfig({ workflow: manual('speckit') });

    const { result } = await runPhase({
      project: { projectDir, sessionId },
      planner,
      callbacks,
      config,
      state: { ...createInitialState('feature'), phase: 'idle' },
      feature: 'feature',
    });

    expect(result.disposition).toBe('ready-for-tasks');
    expect(result.state.phase).toBe('implementing');
    const recompiled = calls.filter((entry) => entry.call === 'tasks');
    expect(recompiled.at(-1)?.inputs.plan).toContain('User-edited JWT plan.');
  });
});

describe('runPlanningPhase — a spec revision on an expired planner thread', () => {
  const TRANSCRIPT_LINE = 'The export must be named PERIWINKLE-42.';
  const revise = () =>
    makeCallbacks({
      onApprovalNeeded: sequencedApproval([
        { approved: false, action: 'revise', comment: 'add auth section' },
        { approved: true },
        { approved: true },
      ]),
    }).callbacks;

  it('issues the revision again on a fresh session with the transcript, and never halts', async () => {
    const project = setupProject(dirs);
    appendMessage(project, { role: 'user', phase: 'researching', text: TRANSCRIPT_LINE });
    const { planner, regenerate } = makeExpiredThreadPlanner('thread-gone', async (opts) => {
      opts.callbacks.onSessionId?.('thread-fresh');
      return { text: '# Regenerated Spec\n\nauth section added.\n', usage: null };
    });

    const { result, events } = await runPhase({
      project,
      planner,
      callbacks: revise(),
      config: makeConfig({ workflow: manual() }),
      state: { ...prepareState(), plannerSessionId: 'thread-gone' },
    });

    expect(result.disposition).toBe('ready-for-tasks');
    expect(regenerate).toHaveBeenCalledTimes(2);
    expect(regenerate.mock.calls[0]?.[0].priorMessages).toBeUndefined();
    expect(regenerate.mock.calls[1]?.[0].priorMessages).toEqual([
      { role: 'user', content: TRANSCRIPT_LINE },
      { role: 'user', content: 'add auth section' },
    ]);
    const saved = loadState(project);
    expect(saved?.pendingRecovery).toBeUndefined();
    expect(saved?.plannerSessionId).toBe('thread-fresh');
    expect(
      events.filter(
        (event) => event.type === 'warning' && event.code === 'planner_session_expired',
      ),
    ).toHaveLength(1);
  });

  it('halts when the revision issued again fails too, and quotes that failure', async () => {
    const project = setupProject(dirs);
    const { planner, regenerate } = makeExpiredThreadPlanner('thread-gone', async () => {
      throw new Error('stream disconnected before completion');
    });

    const { result, events } = await runPhase({
      project,
      planner,
      callbacks: revise(),
      config: makeConfig({ workflow: manual() }),
      state: { ...prepareState(), plannerSessionId: 'thread-gone' },
    });

    expect(result).toMatchObject({ disposition: 'terminal', outcome: 'halted' });
    expect(regenerate).toHaveBeenCalledTimes(2);
    const halted = loadState(project);
    expect(halted?.pendingRecovery?.reason).toBe('planner-call-failed');
    expect(halted?.plannerSessionId).toBeNull();
    expect(events.filter((event) => event.type === 'error')).toEqual([
      expect.objectContaining({
        message: expect.stringContaining('stream disconnected before completion'),
      }),
    ]);
  });
});
