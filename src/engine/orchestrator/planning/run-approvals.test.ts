import { plainUserMessage } from '../../../core/types/user-input.js';

import { describe, it, expect, vi, afterEach } from 'vitest';
import { createInitialState } from '../../../core/state/machine.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeCallbacks } from '#testing/helpers/orchestrator-factories.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { PLAN_JSON_FILE } from '../../../core/paths.js';
import { writeSpecFile } from '../../../core/paths-io.js';
import type { OrchestratorCallbacks } from '../types.js';
import { makePlanProposal, makeTaskSpec } from '#testing/helpers/factories/plan.js';
import { scriptedTypedCall, typedCallFromTasks } from '#testing/helpers/typed-planner.js';
import {
  setupProject,
  makePassingTask,
  makePassingPlanner,
  sequencedApproval,
  auto,
  manual,
  runOwnedPlanningPhase,
  type OwnedRunOpts,
} from '#testing/helpers/planning-phase.js';

let dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs) cleanupTempDir(d);
  dirs = [];
});

function runTurn(opts: OwnedRunOpts = {}) {
  return runOwnedPlanningPhase(dirs, opts);
}

describe('runPlanningPhase — the plan card', () => {
  it('reaches implementing without user interaction when the run asks no approval', async () => {
    const { callbacks } = makeCallbacks();
    const typedCall = typedCallFromTasks([makePassingTask('T099')], {
      inputTokens: 50,
      outputTokens: 25,
    });
    const planner = makePassingPlanner({ typedCall });

    const { result } = await runTurn({
      planner,
      callbacks,
      config: makeConfig({ workflow: auto() }),
    });

    expect(result.disposition).toBe('ready-for-tasks');
    expect(result.state.phase).toBe('implementing');
    expect(typedCall).toHaveBeenCalledTimes(1);
    expect(result.tasks.map((task) => task.id)).toEqual(['T099']);
    expect(callbacks.onApprovalNeeded).not.toHaveBeenCalled();
  });

  it('opens the plan card once and builds what it approves', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
    const onApprovalNeeded = vi.fn(async () => {
      clock.mockReturnValue(2000);
      return { approved: true } as const;
    });
    const { callbacks } = makeCallbacks({ onApprovalNeeded });

    const { result, events } = await runTurn({
      planner: makePassingPlanner(),
      callbacks,
      config: makeConfig({ workflow: manual() }),
    });

    expect(result.disposition).toBe('ready-for-tasks');
    expect(result.state.phase).toBe('implementing');
    expect(onApprovalNeeded).toHaveBeenCalledTimes(1);
    expect(onApprovalNeeded).toHaveBeenCalledWith('plan', expect.stringMatching(/plan\.md$/), []);
    expect(events.find((event) => event.type === 'tasks_planned')).toMatchObject({
      phase: 'planning',
      ts: 1000,
      total: result.tasks.length,
      tasks: result.tasks.map((task, index) =>
        expect.objectContaining({ id: task.id, title: task.title, index }),
      ),
    });
  });

  it('a change request at the plan card goes back into the session with the revised plan', async () => {
    const onApprovalNeeded = sequencedApproval([
      { approved: false, action: 'revise', message: plainUserMessage('add auth section') },
      { approved: true },
    ]);
    const { callbacks } = makeCallbacks({ onApprovalNeeded });
    const typed = scriptedTypedCall([makePlanProposal(), makePlanProposal()]);
    const planner = makePassingPlanner({ typedCall: typed.typedCall });

    const { result } = await runTurn({
      planner,
      callbacks,
      config: makeConfig({ workflow: manual() }),
    });

    expect(result.disposition).toBe('ready-for-tasks');
    expect(result.state.phase).toBe('implementing');
    expect(typed.prompts).toHaveLength(2);
    expect(typed.prompts[1]).toContain('add auth section');
    expect(onApprovalNeeded).toHaveBeenCalledTimes(2);
  });

  it("revises the plan at the card with the run's skills context", async () => {
    const skillsContext = '## Active Project Skills\n\n### AuthSkill\nGATE-SKILL-BODY';
    const onApprovalNeeded = sequencedApproval([
      { approved: false, action: 'revise', message: plainUserMessage('add auth section') },
      { approved: true },
    ]);
    const { callbacks } = makeCallbacks({ onApprovalNeeded });
    const typed = scriptedTypedCall([makePlanProposal(), makePlanProposal()]);
    const planner = makePassingPlanner({ typedCall: typed.typedCall });

    const { result } = await runTurn({
      planner,
      callbacks,
      config: makeConfig({ workflow: manual() }),
      skillsContext,
    });

    expect(result.disposition).toBe('ready-for-tasks');
    expect(typed.prompts.every((prompt) => prompt.includes('GATE-SKILL-BODY'))).toBe(true);
  });

  it('builds the plan.json the user edited at the card without asking the planner again', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const typed = scriptedTypedCall([makePlanProposal()]);
    const edited = makePlanProposal({
      tasks: [makeTaskSpec({ title: 'User-edited JWT task' })],
    });
    const onApprovalNeeded = vi
      .fn<OrchestratorCallbacks['onApprovalNeeded']>()
      .mockImplementationOnce(async () => {
        writeSpecFile(
          { projectDir, sessionId },
          PLAN_JSON_FILE,
          `${JSON.stringify(edited, null, 2)}\n`,
          null,
        );
        return { approved: false, action: 'edit' };
      })
      .mockResolvedValueOnce({ approved: true });
    const { callbacks } = makeCallbacks({ onApprovalNeeded });

    const { result } = await runTurn({
      project: { projectDir, sessionId },
      planner: makePassingPlanner({ typedCall: typed.typedCall }),
      callbacks,
      config: makeConfig({ workflow: manual() }),
      state: { ...createInitialState('feature'), phase: 'idle' },
      feature: 'feature',
    });

    expect(result.disposition).toBe('ready-for-tasks');
    expect(result.state.phase).toBe('implementing');
    expect(typed.prompts).toHaveLength(1);
    expect(result.tasks.map((task) => task.title)).toEqual(['User-edited JWT task']);
  });
});
