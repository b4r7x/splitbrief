import { afterEach, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makePlanProposal } from '#testing/helpers/factories/plan.js';
import { makeCallbacks, makePlanner, makeWctx } from '#testing/helpers/orchestrator-factories.js';
import { makePassingTask } from '#testing/helpers/planning-phase.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { scriptedTypedCall } from '#testing/helpers/typed-planner.js';
import { PLAN_FILE, TASKS_FILE, sessionDir } from '../../../core/paths.js';
import { ensureSessionDir } from '../../../core/paths-io.js';
import { createInitialState, transition } from '../../../core/state/machine.js';
import { PlanSchema } from '../../../core/schemas/plan.js';
import { writePlanJson } from '../../../core/sessions/plan-file.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { formatTasks } from '../../spec/formatter.js';
import { formatPlanMarkdown } from '../../spec/plan-markdown.js';
import { taskFromSpec } from '../../spec/plan-tasks.js';
import { createContinuationHolder } from '../continuation.js';
import { resumeParkedApproval } from './resume-parked-approval.js';

let projectDir = '';
afterEach(() => cleanupTempDir(projectDir));

it('leaves a run parked at the old briefs gate to the planning session', async () => {
  projectDir = createTempDir('parked-briefs-gate');
  const sessionId = 'sess-parked-briefs';
  ensureSessionDir(projectDir, sessionId);
  const tasks = [makePassingTask()];
  writeFileSync(join(sessionDir(projectDir, sessionId), TASKS_FILE), formatTasks(tasks));
  const onApprovalNeeded = vi.fn();
  const state: WorkflowState = {
    ...transition(createInitialState('feature'), { type: 'START' }),
    phase: 'reviewing-briefs',
    mode: 'standard',
    approve: 'plan',
    tasks,
  };

  const result = await resumeParkedApproval({
    wctx: makeWctx({
      projectDir,
      sessionId,
      config: makeConfig({ workflow: { approve: 'plan' } }),
      callbacks: makeCallbacks({ onApprovalNeeded }).callbacks,
    }),
    state,
    setTrackedState: () => {},
    phaseTimings: {},
    startTime: Date.now(),
  });

  expect(result).toBeNull();
  expect(onApprovalNeeded).not.toHaveBeenCalled();
});

it('reopens a parked plan card and sends the correction typed at it to the planning session', async () => {
  projectDir = createTempDir('parked-plan-card');
  const sessionId = 'sess-parked-card';
  ensureSessionDir(projectDir, sessionId);
  const proposal = makePlanProposal();
  writePlanJson({ projectDir, sessionId }, proposal);
  writeFileSync(join(sessionDir(projectDir, sessionId), PLAN_FILE), formatPlanMarkdown(proposal));
  const state: WorkflowState = {
    ...transition(createInitialState('feature'), { type: 'START' }),
    phase: 'reviewing-plan',
    plan: PlanSchema.parse(proposal),
    tasks: proposal.tasks.map((spec) => taskFromSpec(spec, projectDir)),
  };
  const typed = scriptedTypedCall([makePlanProposal({ summary: 'Greet people in Polish' })]);
  const onApprovalNeeded = vi.fn().mockResolvedValue({ approved: true });
  const wctx = makeWctx({
    projectDir,
    sessionId,
    planner: makePlanner({ typedCall: typed.typedCall }),
    config: makeConfig({
      codebase: { enabled: false, tokenBudget: 4000 },
      workflow: { approve: 'plan' },
    }),
    callbacks: makeCallbacks({ onApprovalNeeded }).callbacks,
  });
  wctx.continuation = createContinuationHolder({
    step: { kind: 'gate', gate: 'plan' },
    steer: 'Greet in Polish',
  });

  const result = await resumeParkedApproval({
    wctx,
    state,
    setTrackedState: () => {},
    phaseTimings: {},
    startTime: Date.now(),
  });

  expect(typed.prompts).toHaveLength(1);
  expect(typed.prompts[0]).toContain('Greet in Polish');
  expect(typed.prompts[0]).toContain('"summary": "Greet people by name"');
  expect(onApprovalNeeded).toHaveBeenCalledTimes(1);
  expect(onApprovalNeeded).toHaveBeenCalledWith('plan', expect.stringMatching(/plan\.md$/), []);
  expect(result).toMatchObject({
    disposition: 'ready-for-tasks',
    state: { phase: 'implementing', plan: { summary: 'Greet people in Polish' } },
  });
});
