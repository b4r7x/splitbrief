import { expect, it } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makePlanProposal, makeTaskSpec } from '#testing/helpers/factories/plan.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeWorkflowState } from '#testing/helpers/factories/workflow-state.js';
import {
  makeBusRecorder,
  makeCallbacks,
  TEST_SINKS,
} from '#testing/helpers/orchestrator-factories.js';
import { PlanSchema } from '../../../core/schemas/plan.js';
import { createValidator } from '../validation/run.js';
import { applyConsultAnswer } from './apply.js';

it('quotes the criteria the planner would remove and add to the brief', async () => {
  const task = makeTask({ criteria: ['C1'] });
  const proposal = makePlanProposal({
    criteria: [
      { id: 'C1', text: 'Keep archived entries.', checkIds: [] },
      { id: 'C4', text: 'Delete archived entries.', checkIds: [] },
    ],
  });
  const plan = PlanSchema.parse(proposal);
  const snapshot = { head: '', files: [], dirtyFileContents: {} };
  const result = await applyConsultAnswer(
    {
      projectDir: '/project',
      workspaceDir: '/project',
      sessionId: 'consult',
      taskStartSnapshot: snapshot,
      bus: makeBusRecorder().bus,
      config: makeConfig(),
      validator: createValidator(),
      callbacks: makeCallbacks({ onPlannerReply: async () => undefined }).callbacks,
      sinks: TEST_SINKS,
      state: makeWorkflowState({ phase: 'escalating', plan, tasks: [task] }),
    },
    task,
    {
      answer: {
        action: 'rewrite-task',
        diagnosis: 'Change the archive rules.',
        task: makeTaskSpec({ criteria: ['C4'] }),
      },
    },
    snapshot,
  );
  expect(result).toMatchObject({
    action: 'unanswered',
    question: expect.stringContaining('brief'),
  });
  if (result.action === 'unanswered') {
    expect(result.question).toContain('Keep archived entries.');
    expect(result.question).toContain('Delete archived entries.');
  }
});
