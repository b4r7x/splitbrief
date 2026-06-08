import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { OrchestratorCallbacks } from '../types.js';
import type { EventBus } from '../../events/types.js';
import { readSpecFileOrEmpty, writeSpecFile, type SpecMetadata } from '../../../core/paths-io.js';
import { SPEC_FILE, PLAN_FILE } from '../../../core/paths.js';
import { buildRegeneratePrompt } from '../../spec/prompts/plan.js';
import type { Planner } from '../../planners/types.js';
import { createBusTextHandler, publishPlannerStatus } from '../events.js';
import { addUsageAndSave, transitionAndSave } from '../state-ops.js';
import { appendMessage } from '../../../core/state/persistence.js';
import { isAbortError } from '../../../utils/abort.js';

type ApprovalLoopOptions = {
  type: 'spec' | 'plan';
  filePath: string;
  planner: Planner;
  projectDir: string;
  sessionId: string;
  callbacks: OrchestratorCallbacks;
  bus: EventBus;
  state: WorkflowState;
  signal?: AbortSignal | undefined;
  persistTranscript: boolean;
  specMetadata?: SpecMetadata | null | undefined;
};

export async function runApprovalLoop(opts: ApprovalLoopOptions): Promise<{
  state: WorkflowState;
  rejected: boolean;
  regenerated: boolean;
  aborted?: boolean | undefined;
}> {
  const {
    type,
    filePath,
    planner,
    projectDir,
    sessionId,
    callbacks,
    bus,
    signal,
    persistTranscript,
  } = opts;
  let { state } = opts;
  let regenerated = false;
  const rejectType = type === 'spec' ? 'REJECT_SPEC' : 'REJECT_PLAN';
  const isSpec = type === 'spec';
  const rejectedEvent = isSpec ? ('spec_rejected' as const) : ('plan_rejected' as const);
  const regeneratedEvent = isSpec ? ('spec_regenerated' as const) : ('plan_regenerated' as const);
  const filename = type === 'spec' ? SPEC_FILE : PLAN_FILE;

  while (true) {
    if (signal?.aborted) return { state, rejected: false, regenerated, aborted: true };
    const result = await callbacks.onApprovalNeeded(type, filePath);
    if (signal?.aborted) return { state, rejected: false, regenerated, aborted: true };
    if (!result.approved && !result.comment) {
      state = transitionAndSave({ projectDir, sessionId }, state, { type: rejectType });
      publishPlannerStatus(bus, state, 'done');
      bus.publish({ type: rejectedEvent, ts: Date.now(), phase: state.phase });
      return { state, rejected: true, regenerated };
    }
    if (!result.comment) return { state, rejected: false, regenerated };

    appendMessage(
      { projectDir, sessionId },
      {
        role: 'user',
        phase: type === 'spec' ? 'reviewing-spec' : 'reviewing-plan',
        text: result.comment,
      },
      persistTranscript,
    );

    const current = readSpecFileOrEmpty({ projectDir, sessionId }, filename);
    const regenPrompt = buildRegeneratePrompt(type, current, result.comment);
    createBusTextHandler({ bus: bus, phase: state.phase })(
      `\n[Regenerating ${type} with feedback: ${result.comment}]\n`,
    );
    let regenResult: Awaited<ReturnType<Planner['regenerate']>>;
    try {
      regenResult = await planner.regenerate({
        prompt: regenPrompt,
        projectDir,
        callbacks: {
          onOutput: createBusTextHandler({ bus: bus, phase: state.phase }),
          signal,
        },
      });
    } catch (err) {
      if (signal?.aborted || isAbortError(err))
        return { state, rejected: false, regenerated, aborted: true };
      throw err;
    }
    state = addUsageAndSave({ projectDir, sessionId, bus }, state, 'planner', regenResult.usage);
    writeSpecFile({ projectDir, sessionId }, filename, regenResult.text, opts.specMetadata ?? null);
    regenerated = true;
    bus.publish({
      type: regeneratedEvent,
      ts: Date.now(),
      phase: state.phase,
      comment: result.comment,
    });
  }
}
