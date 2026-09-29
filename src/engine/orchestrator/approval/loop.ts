import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { OrchestratorCallbacks } from '../types.js';
import type { EventBus } from '../../events/types.js';
import { readSpecFileOrEmpty, type SpecMetadata } from '../../../core/paths-io.js';
import { SPEC_FILE, PLAN_FILE } from '../../../core/paths.js';
import { buildRegeneratePrompt } from '../../spec/prompts/plan.js';
import type { Planner } from '../../planners/types.js';
import { withPerCallAbort } from '../cancellable-call.js';
import { createBusTextHandler, publishPlannerStatus } from '../events.js';
import { writeAndPublishArtifact } from '../artifact-write.js';
import { addUsageAndSave, plannerThreadCallbacks, transitionAndSave } from '../state-ops.js';
import { appendMessage } from '../../../core/sessions/log-writer.js';
import { invalidateFrom } from '../planning/invalidate.js';
import { withExpiredSessionReissue } from '../resume-context.js';
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
  specMetadata?: SpecMetadata | null | undefined;
  sinks?: WorkflowSinks | undefined;
  skillsContext?: string | undefined;
};

export async function runApprovalLoop(opts: ApprovalLoopOptions): Promise<{
  state: WorkflowState;
  closed: boolean;
  regenerated: boolean;
  aborted?: boolean | undefined;
}> {
  const { type, filePath, planner, projectDir, sessionId, callbacks, bus, signal } = opts;
  let { state } = opts;
  const thread = plannerThreadCallbacks(
    { projectDir, sessionId },
    {
      get: () => state,
      set: (next) => {
        state = next;
      },
    },
  );
  let regenerated = false;
  const isSpec = type === 'spec';
  const approvedEvent = isSpec ? ('spec_approved' as const) : ('plan_approved' as const);
  const closedEvent = isSpec ? ('spec_rejected' as const) : ('plan_rejected' as const);
  const regeneratedEvent = isSpec ? ('spec_regenerated' as const) : ('plan_regenerated' as const);
  const filename = type === 'spec' ? SPEC_FILE : PLAN_FILE;
  const regenerationPhase = type === 'spec' ? ('specifying' as const) : ('planning' as const);
  let snapshot = readSpecFileOrEmpty({ projectDir, sessionId }, filename);

  while (true) {
    if (signal?.aborted) return { state, closed: false, regenerated, aborted: true };
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
          skillsContext: opts.skillsContext,
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
            sessionId,
            bus,
            state,
            thread,
            statusPhase: regenerationPhase,
            call: type,
            summary: `applying queued input before ${type} review`,
            prompt: regenPrompt,
            signal,
            sinks: opts.sinks,
          });
        } catch (err) {
          if (signal?.aborted || isAbortError(err))
            return { state, closed: false, regenerated, aborted: true };
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
    if (signal?.aborted) return { state, closed: false, regenerated, aborted: true };
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
    if (!result.approved && result.action === 'end-run') {
      state = transitionAndSave({ projectDir, sessionId }, state, { type: 'CLOSE_RUN' });
      publishPlannerStatus(bus, state, 'done');
      bus.publish({ type: closedEvent, ts: Date.now(), phase: state.phase });
      return { state, closed: true, regenerated };
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
      bus.publish({ type: approvedEvent, ts: Date.now(), phase: state.phase });
      return { state, closed: false, regenerated };
    }

    // Anything that is not an answer re-opens the gate rather than ending the run.
    const comment = result.action === 'revise' ? result.comment.trim() : '';
    if (comment === '') continue;
    if (result.action === 'revise' && result.recorded !== true) {
      appendMessage(
        { projectDir, sessionId },
        {
          role: 'user',
          phase: type === 'spec' ? 'reviewing-spec' : 'reviewing-plan',
          text: comment,
        },
      );
    }

    const current = readSpecFileOrEmpty({ projectDir, sessionId }, filename);
    const regenPrompt = buildRegeneratePrompt({
      artifactType: type,
      currentContent: current,
      feedback: comment,
      skillsContext: opts.skillsContext,
    });
    createBusTextHandler({ bus: bus, phase: state.phase })(
      `\n[Regenerating ${type} with feedback: ${comment}]\n`,
    );
    let regenResult: Awaited<ReturnType<Planner['regenerate']>>;
    try {
      regenResult = await runLiveRegenerate({
        planner,
        projectDir,
        sessionId,
        bus,
        state,
        thread,
        statusPhase: regenerationPhase,
        call: type,
        summary: `regenerating ${type} from feedback`,
        prompt: regenPrompt,
        signal,
        sinks: opts.sinks,
      });
    } catch (err) {
      if (signal?.aborted || isAbortError(err))
        return { state, closed: false, regenerated, aborted: true };
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
    invalidateFrom({ projectDir, sessionId }, type);
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
  sessionId: string;
  bus: EventBus;
  state: WorkflowState;
  thread: ReturnType<typeof plannerThreadCallbacks>;
  statusPhase: 'specifying' | 'planning';
  call: 'spec' | 'plan';
  summary: string;
  prompt: string;
  signal?: AbortSignal | undefined;
  sinks?: WorkflowSinks | undefined;
}): Promise<Awaited<ReturnType<Planner['regenerate']>>> {
  publishPlannerStatus(opts.bus, { ...opts.state, phase: opts.statusPhase }, 'running', {
    call: opts.call,
  });
  opts.bus.publish({
    type: 'planner_heartbeat',
    ts: Date.now(),
    phase: opts.statusPhase,
    elapsedMs: 0,
    accumulatedTokens: 0,
    phaseHint: opts.summary,
  } satisfies EngineEventOf<'planner_heartbeat'>);

  try {
    return await withPerCallAbort({
      sinks: opts.sinks,
      signal: opts.signal,
      run: (signal) =>
        withExpiredSessionReissue({
          projectDir: opts.projectDir,
          sessionId: opts.sessionId,
          bus: opts.bus,
          planner: opts.planner,
          state: opts.state,
          signal,
          issue: (priorMessages) =>
            opts.planner.regenerate({
              prompt: opts.prompt,
              projectDir: opts.projectDir,
              callbacks: {
                // The reply is the regenerated document itself; it reaches the transcript as the
                // artifact card published once it is written, never as a body paste.
                onOutput: () => {},
                signal,
                ...opts.thread,
              },
              priorMessages,
            }),
        }),
    });
  } finally {
    publishPlannerStatus(opts.bus, { ...opts.state, phase: opts.statusPhase }, 'done', {
      call: opts.call,
    });
  }
}
