import { createBusTextHandler, publishRunnerCallEvent, publishWarning } from '../events.js';
import { transitionAndSave } from '../state-ops.js';
import { createSessionExpiredHandler } from '../resume-context.js';
import { withContinuationLoop } from '../continuation.js';
import { readEvidenceLedger } from '../../../core/evidence/ledger-storage.js';
import { buildRejectionContext } from '../evidence/reporting.js';
import { startPlannerHeartbeat } from './heartbeat.js';
import { createQuestionMarkerStripper } from '../../parsers/question.js';
import { composeSteeredPrompt } from '../../spec/prompts/steered-prompt.js';
import type { PlanResult, PlannerCallbacks } from '../../planners/types.js';
import type { TokenDelta } from '../../../core/schemas/tokens.js';
import type { ClarificationQuestion } from '../../../core/schemas/question.js';
import type { PlannerCallRunResult, PlannerCallOptions } from './types.js';

const MAX_CLARIFICATION_QUESTIONS = 5;

function createClarificationQuestionCollector(
  questions: ClarificationQuestion[],
): (incoming: ClarificationQuestion[]) => void {
  const seenIds = new Set(questions.map((question) => question.id));

  return (incoming) => {
    for (const question of incoming) {
      if (seenIds.has(question.id)) continue;
      seenIds.add(question.id);
      if (questions.length >= MAX_CLARIFICATION_QUESTIONS) continue;
      questions.push(question);
    }
  };
}

export async function runPlannerCallInContinuationLoop(
  opts: PlannerCallOptions,
): Promise<PlannerCallRunResult> {
  const {
    wctx,
    planner,
    feature,
    skillsContext,
    codebaseContext,
    priorMessages,
    collectedQuestions,
    attachments,
    trivial,
  } = opts;
  const { projectDir, sessionId, config, callbacks, resumeHolder, sinks, signal } = wctx;
  let state = opts.state;
  const textHandler = createBusTextHandler(
    { bus: wctx.bus, phase: state.phase },
    { content: 'markdown' },
  );
  let attachmentsConsumed = false;

  const heartbeat = startPlannerHeartbeat(wctx.bus, state.phase, Date.now());
  if (opts.phaseHint) heartbeat.updatePhaseHint(opts.phaseHint);
  const collectQuestions = collectedQuestions
    ? createClarificationQuestionCollector(collectedQuestions)
    : undefined;

  try {
    const loop = await withContinuationLoop<PlanResult>({
      ctx: { projectDir, sessionId, callbacks, bus: wctx.bus, signal, sinks },
      state,
      onStateChange: (s) => {
        state = s;
      },
      body: async ({ signal: callSignal, continuationPrompt, steer, recordOutput }) => {
        const stripper = createQuestionMarkerStripper();
        let prompt = composeSteeredPrompt(continuationPrompt ?? feature, steer);

        if (config.approval?.feedRejectionsToPlanner !== false) {
          try {
            const ledger = readEvidenceLedger({ projectDir, sessionId });
            if (ledger) {
              const rejectionCtx = buildRejectionContext(ledger);
              if (rejectionCtx.length > 0) {
                prompt = `${rejectionCtx}\n${prompt}`;
              }
            }
          } catch {
            // Best-effort: never fail the planner call because the ledger is unreadable.
          }
        }

        const callAttachments =
          !attachmentsConsumed && attachments && attachments.length > 0 ? attachments : undefined;
        attachmentsConsumed = true;
        const plannerCallbacks: PlannerCallbacks = {
          onOutput: (text) => {
            recordOutput(text);
            const display = stripper.push(text);
            if (display.length > 0) textHandler(display);
          },
          onWarning: (message) =>
            publishWarning({ bus: wctx.bus, phase: state.phase, message: message }),
          onSessionId: (id) => {
            state = transitionAndSave({ projectDir, sessionId }, state, {
              type: 'SET_PLANNER_SESSION_ID',
              sessionId: id,
            });
          },
          onCallEvent: (event) => {
            if (event.type === 'call_started') heartbeat.updateCallId(event.callId);
            publishRunnerCallEvent({ bus: wctx.bus, phase: state.phase }, event);
          },
          onSessionExpired: createSessionExpiredHandler({
            projectDir,
            sessionId,
            bus: wctx.bus,
            resumeHolder,
          }),
          sessionId,
          signal: callSignal,
          ...(priorMessages && priorMessages.length > 0 ? { priorMessages } : {}),
          ...(callAttachments ? { attachments: callAttachments } : {}),
          ...(state.discoveredValidation !== undefined
            ? { discoveredValidation: state.discoveredValidation }
            : {}),
          ...(collectQuestions
            ? {
                onQuestion: collectQuestions,
              }
            : {}),
        };

        try {
          const result = await planner.plan({
            feature: prompt,
            projectDir,
            callbacks: plannerCallbacks,
            skillsContext,
            codebaseContext,
            ...(trivial === true ? { trivial: true } : {}),
          });
          heartbeat.updateTokens(plannerCallTokens(result.usage));
          return result;
        } finally {
          // The stripper holds text that could still turn out to be a question marker. An
          // abort or a planner crash ends the call with that text unreleased, so the flush
          // has to run on every exit or the narration it holds never reaches the transcript.
          const rest = stripper.flush();
          if (rest.length > 0) textHandler(rest);
        }
      },
    });

    return { state, result: loop.value };
  } finally {
    heartbeat.stop();
  }
}

function plannerCallTokens(usage: TokenDelta | null): number {
  if (usage === null) return 0;
  return usage.inputTokens + usage.outputTokens;
}
