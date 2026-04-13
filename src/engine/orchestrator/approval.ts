import type { WorkflowState, OrchestratorCallbacks } from '../../types.js';
import { readSpecFileOrEmpty } from '../../core/paths-io.js';
import { SPEC_FILE, PLAN_FILE } from '../../core/paths.js';
import { buildRegeneratePrompt } from '../spec/prompts/plan.js';
import type { Planner } from '../planners/types.js';
import { emit, createTextHandler, emitPlannerStatus } from './events.js';
import { addUsageAndSave, transitionAndSave } from './helpers.js';

export type ApprovalLoopOptions = {
  type: 'spec' | 'plan';
  filePath: string;
  planner: Planner;
  projectDir: string;
  callbacks: OrchestratorCallbacks;
  state: WorkflowState;
};

export async function runApprovalLoop(opts: ApprovalLoopOptions): Promise<{ state: WorkflowState; rejected: boolean; regenerated: boolean }> {
  const { type, filePath, planner, projectDir, callbacks } = opts;
  let { state } = opts;
  let regenerated = false;
  const rejectType = type === 'spec' ? 'REJECT_SPEC' : 'REJECT_PLAN';
  const [rejectedEvent, regeneratedEvent] = type === 'spec'
    ? ['spec_rejected', 'spec_regenerated'] as const
    : ['plan_rejected', 'plan_regenerated'] as const;
  const filename = type === 'spec' ? SPEC_FILE : PLAN_FILE;

  while (true) {
    const result = await callbacks.onApprovalNeeded(type, filePath);
    if (!result.approved && !result.comment) {
      state = transitionAndSave(projectDir, state, { type: rejectType });
      emitPlannerStatus(callbacks, state, 'done');
      emit(projectDir, state, rejectedEvent, undefined, {});
      return { state, rejected: true, regenerated };
    }
    if (!result.comment) return { state, rejected: false, regenerated };

    const current = readSpecFileOrEmpty(projectDir, filename);
    const regenPrompt = buildRegeneratePrompt(type, current, result.comment);
    createTextHandler(callbacks)(`\n[Regenerating ${type} with feedback: ${result.comment}]\n`);
    const regenResult = await planner.regenerate(regenPrompt, type, projectDir, {
      onOutput: createTextHandler(callbacks),
    });
    state = addUsageAndSave(projectDir, state, 'planner', regenResult.usage, callbacks);
    regenerated = true;
    emit(projectDir, state, regeneratedEvent, undefined, { comment: result.comment });
  }

}
