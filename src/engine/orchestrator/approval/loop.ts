import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { OrchestratorCallbacks } from '../types.js';
import type { EventBus } from '../../events/types.js';
import { readSpecFileOrEmpty, type SpecMetadata } from '../../../core/paths-io.js';
import { SPEC_FILE, PLAN_FILE } from '../../../core/paths.js';
import { buildRegeneratePrompt } from '../../spec/prompts/plan.js';
import type { Planner } from '../../planners/types.js';
import { createBusTextHandler, publishPlannerStatus } from '../events.js';
import { writeAndPublishArtifact } from '../artifact-write.js';
import { addUsageAndSave, transitionAndSave } from '../state-ops.js';
import { appendMessage } from '../../../core/sessions/log-writer.js';
import { isAbortError } from '../../../utils/abort.js';
import {
  commitQueueMessagesDrained,
  readQueueForPrompt,
  releaseQueueMessagesForPrompt,
} from '../queue/drain.js';
import { formatDrainedMessages } from '../queue/prompt.js';
import type { WorkflowSinks } from '../types.js';
import type { EngineEventOf } from '../../events/types.js';

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
  sinks?: WorkflowSinks | undefined;
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
  const regenerationPhase = type === 'spec' ? ('specifying' as const) : ('planning' as const);
  let snapshot = readSpecFileOrEmpty({ projectDir, sessionId }, filename);

  while (true) {
    if (signal?.aborted) return { state, rejected: false, regenerated, aborted: true };
    const queue = readQueueForPrompt({ projectDir, sessionId, state });
    if (queue.messages.length > 0) {
      try {
        state = queue.state;
        const comment = formatDrainedMessages(queue.messages).trim();
        const current = readSpecFileOrEmpty({ projectDir, sessionId }, filename);
        const regenPrompt = buildRegeneratePrompt({
          artifactType: type,
          currentContent: current,
          feedback: comment,
        });
        createBusTextHandler({ bus, phase: state.phase })(
          `\n[Applying ${queue.messages.length} queued message${
            queue.messages.length === 1 ? '' : 's'
          } before ${type} review]\n`,
        );
        let regenResult: Awaited<ReturnType<Planner['regenerate']>>;
        try {
          regenResult = await runLiveRegenerate({
            planner,
            projectDir,
            bus,
            state,
            statusPhase: regenerationPhase,
            summary: `applying queued input before ${type} review`,
            prompt: regenPrompt,
            signal,
            sinks: opts.sinks,
          });
        } catch (err) {
          if (signal?.aborted || isAbortError(err))
            return { state, rejected: false, regenerated, aborted: true };
          throw err;
        }
        state = addUsageAndSave(
          { projectDir, sessionId, bus },
          state,
          'planner',
          regenResult.usage,
        );
        writeAndPublishArtifact({
          projectDir,
          sessionId,
          bus,
          phase: state.phase,
          kind: isSpec ? 'spec' : 'plan',
          text: regenResult.text,
          metadata: opts.specMetadata ?? null,
        });
        state = commitQueueMessagesDrained({
          projectDir,
          sessionId,
          state,
          messages: queue.messages,
          bus,
        }).state;
        snapshot = readSpecFileOrEmpty({ projectDir, sessionId }, filename);
        regenerated = true;
        bus.publish({
          type: regeneratedEvent,
          ts: Date.now(),
          phase: state.phase,
          comment: `(queued input before ${type} review)`,
        });
        continue;
      } finally {
        releaseQueueMessagesForPrompt({ projectDir, sessionId }, queue.messages);
      }
    }

    const result = await callbacks.onApprovalNeeded(type, filePath);
    if (signal?.aborted) return { state, rejected: false, regenerated, aborted: true };
    if (!result.approved && result.action === 'edit') {
      const edited = readSpecFileOrEmpty({ projectDir, sessionId }, filename);
      if (edited !== snapshot) {
        snapshot = edited;
        regenerated = true;
        bus.publish({
          type: regeneratedEvent,
          ts: Date.now(),
          phase: state.phase,
          comment: `(edited ${filename})`,
        });
      }
      continue;
    }
    if (!result.approved && result.action !== 'revise') {
      state = transitionAndSave({ projectDir, sessionId }, state, { type: rejectType });
      publishPlannerStatus(bus, state, 'done');
      bus.publish({ type: rejectedEvent, ts: Date.now(), phase: state.phase });
      return { state, rejected: true, regenerated };
    }
    if (result.approved) {
      const edited = readSpecFileOrEmpty({ projectDir, sessionId }, filename);
      if (edited !== snapshot) {
        regenerated = true;
        bus.publish({
          type: regeneratedEvent,
          ts: Date.now(),
          phase: state.phase,
          comment: `(edited ${filename})`,
        });
      }
      return { state, rejected: false, regenerated };
    }

    const comment = result.comment;
    appendMessage(
      { projectDir, sessionId },
      {
        role: 'user',
        phase: type === 'spec' ? 'reviewing-spec' : 'reviewing-plan',
        text: comment,
      },
      { persistTranscript },
    );

    const current = readSpecFileOrEmpty({ projectDir, sessionId }, filename);
    const regenPrompt = buildRegeneratePrompt({
      artifactType: type,
      currentContent: current,
      feedback: comment,
    });
    createBusTextHandler({ bus: bus, phase: state.phase })(
      `\n[Regenerating ${type} with feedback: ${comment}]\n`,
    );
    let regenResult: Awaited<ReturnType<Planner['regenerate']>>;
    try {
      regenResult = await runLiveRegenerate({
        planner,
        projectDir,
        bus,
        state,
        statusPhase: regenerationPhase,
        summary: `regenerating ${type} from feedback`,
        prompt: regenPrompt,
        signal,
        sinks: opts.sinks,
      });
    } catch (err) {
      if (signal?.aborted || isAbortError(err))
        return { state, rejected: false, regenerated, aborted: true };
      throw err;
    }
    state = addUsageAndSave({ projectDir, sessionId, bus }, state, 'planner', regenResult.usage);
    writeAndPublishArtifact({
      projectDir,
      sessionId,
      bus,
      phase: state.phase,
      kind: isSpec ? 'spec' : 'plan',
      text: regenResult.text,
      metadata: opts.specMetadata ?? null,
    });
    snapshot = readSpecFileOrEmpty({ projectDir, sessionId }, filename);
    regenerated = true;
    bus.publish({
      type: regeneratedEvent,
      ts: Date.now(),
      phase: state.phase,
      comment,
    });
  }
}

async function runLiveRegenerate(opts: {
  planner: Planner;
  projectDir: string;
  bus: EventBus;
  state: WorkflowState;
  statusPhase: 'specifying' | 'planning';
  summary: string;
  prompt: string;
  signal?: AbortSignal | undefined;
  sinks?: WorkflowSinks | undefined;
}): Promise<Awaited<ReturnType<Planner['regenerate']>>> {
  const controller = opts.sinks ? new AbortController() : null;
  const signal = controller
    ? opts.signal === undefined
      ? controller.signal
      : AbortSignal.any([opts.signal, controller.signal])
    : opts.signal;

  if (controller) opts.sinks?.setAbortHandler(() => controller.abort());
  publishPlannerStatus(opts.bus, { ...opts.state, phase: opts.statusPhase }, 'running');
  opts.bus.publish({
    type: 'planner_heartbeat',
    ts: Date.now(),
    phase: opts.statusPhase,
    elapsedMs: 0,
    accumulatedTokens: 0,
    phaseHint: opts.summary,
  } satisfies EngineEventOf<'planner_heartbeat'>);

  try {
    return await opts.planner.regenerate({
      prompt: opts.prompt,
      projectDir: opts.projectDir,
      callbacks: {
        // The reply is the regenerated document itself; it reaches the transcript as the
        // artifact card published once it is written, never as a body paste.
        onOutput: () => {},
        signal,
      },
    });
  } finally {
    opts.sinks?.setAbortHandler(null);
    publishPlannerStatus(opts.bus, { ...opts.state, phase: opts.statusPhase }, 'done');
  }
}
