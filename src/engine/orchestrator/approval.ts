import type { WorkflowState, OrchestratorCallbacks } from '../../types.js';
import { readSpecFileOrEmpty } from '../../core/paths-io.js';
import { SPEC_FILE, PLAN_FILE } from '../../core/paths.js';
import { buildRegeneratePrompt } from '../spec/prompts/plan.js';
import type { Planner } from '../planners/types.js';
import { emit, createTextHandler, emitPlannerStatus } from './events.js';
import { addUsageAndSave, transitionAndSave } from './helpers.js';
import { appendMessage } from '../../core/state/persistence.js';

type ApprovalLoopOptions = {
  type: 'spec' | 'plan';
  filePath: string;
  planner: Planner;
  projectDir: string;
  sessionId: string;
  callbacks: OrchestratorCallbacks;
  state: WorkflowState;
  signal?: AbortSignal | undefined;
  persistTranscript: boolean;
};

export async function runApprovalLoop(opts: ApprovalLoopOptions): Promise<{ state: WorkflowState; rejected: boolean; regenerated: boolean }> {
  const { type, filePath, planner, projectDir, sessionId, callbacks, signal, persistTranscript } = opts;
  let { state } = opts;
  let regenerated = false;
  const rejectType = type === 'spec' ? 'REJECT_SPEC' : 'REJECT_PLAN';
  const [rejectedEvent, regeneratedEvent] = type === 'spec'
    ? ['spec_rejected', 'spec_regenerated'] as const
    : ['plan_rejected', 'plan_regenerated'] as const;
  const filename = type === 'spec' ? SPEC_FILE : PLAN_FILE;

  while (true) {
    if (signal?.aborted) return { state, rejected: false, regenerated };
    const result = await callbacks.onApprovalNeeded(type, filePath);
    if (signal?.aborted) return { state, rejected: false, regenerated };
    if (!result.approved && !result.comment) {
      state = transitionAndSave(projectDir, sessionId, state, { type: rejectType });
      emitPlannerStatus(callbacks, state, 'done');
      emit(projectDir, sessionId, state, rejectedEvent, undefined, {});
      return { state, rejected: true, regenerated };
    }
    if (!result.comment) return { state, rejected: false, regenerated };

    appendMessage(projectDir, sessionId, {
      role: 'user',
      phase: type === 'spec' ? 'reviewing-spec' : 'reviewing-plan',
      text: result.comment,
    }, persistTranscript);

    const current = readSpecFileOrEmpty(projectDir, sessionId, filename);
    const regenPrompt = buildRegeneratePrompt(type, current, result.comment);
    createTextHandler(callbacks)(`\n[Regenerating ${type} with feedback: ${result.comment}]\n`);
    const regenResult = await planner.regenerate(regenPrompt, type, projectDir, {
      onOutput: createTextHandler(callbacks),
    });
    state = addUsageAndSave(projectDir, sessionId, state, 'planner', regenResult.usage, callbacks);
    regenerated = true;
    emit(projectDir, sessionId, state, regeneratedEvent, undefined, { comment: result.comment });
  }

}
