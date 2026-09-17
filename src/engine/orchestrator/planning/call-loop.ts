import {
  createBusTextHandler,
  publishRunnerCallEvent,
  publishUserMessage,
  publishWarning,
} from '../events.js';
import { addUsageAndSave, transitionAndSave } from '../state-ops.js';
import { appendMessage } from '../../../core/sessions/log-writer.js';
import { withPerCallAbort } from '../cancellable-call.js';
import { abortError, throwIfAborted } from '../../../utils/abort.js';
import { createSessionExpiredHandler } from '../resume-context.js';
import { withContinuationLoop } from '../continuation.js';
import { continuationBlock } from '../../spec/prompts/continuation.js';
import { plannerInteractionInstructions } from '../../spec/prompts/builder.js';
import { readEvidenceLedger } from '../../../core/evidence/ledger-storage.js';
import { buildRejectionContext } from '../evidence/reporting.js';
import { startPlannerHeartbeat } from './heartbeat.js';
import { createQuestionMarkerStripper } from '../../parsers/question.js';
import { PLAN_FILE, RESEARCH_FILE, SPEC_FILE, TASKS_FILE } from '../../../core/paths.js';
import type {
  PhaseCallResult,
  PhaseInputs,
  PlannerCallbacks,
  PlannerDocumentCall,
} from '../../planners/types.js';
import type { TokenDelta } from '../../../core/schemas/tokens.js';
import type { PlannerCallRunResult, PlannerCallOptions } from './types.js';

const CALL_ARTIFACT: Record<PlannerDocumentCall, string> = {
  research: RESEARCH_FILE,
  spec: SPEC_FILE,
  plan: PLAN_FILE,
  tasks: TASKS_FILE,
};

/**
 * A seat holding the session this step already ran on has the step's prompt in
 * its own history, so its continuation is one user turn: what the operator said,
 * and what to produce.
 */
export function composePlannerContinuationTurn(
  call: PlannerDocumentCall,
  steer: string | undefined,
  reason: 'interrupted' | 'answer' = 'interrupted',
): string {
  const said = steer?.trim();
  const lead =
    reason === 'answer'
      ? `[User reply] ${said ?? ''}`
      : said === undefined || said === ''
        ? '[Continuation] You were interrupted.'
        : `[Continuation] You were interrupted. The user says: ${said}`;
  return `${lead}\nContinue the ${call} step. When ready, output the complete ${CALL_ARTIFACT[call]}.\n${plannerInteractionInstructions}`;
}

export async function runPlannerCallInContinuationLoop(
  opts: PlannerCallOptions,
): Promise<PlannerCallRunResult> {
  const { wctx, planner, call, inputs } = opts;
  const { projectDir, sessionId, config, callbacks, resumeHolder, sinks, signal } = wctx;
  let state = opts.state;
  const textHandler = createBusTextHandler(
    { bus: wctx.bus, phase: state.phase },
    { content: 'markdown' },
  );

  let seed = wctx.continuation?.take({ kind: 'planner', call });

  while (true) {
    let pending = state.pendingPlannerConversation;
    let answeringQuestion = false;
    if (pending !== undefined && pending.call === call) {
      if (!pending.answered) {
        const reply = pending;
        const resumedAnswer = seed?.steer?.trim();
        const answer =
          resumedAnswer ||
          (await withPerCallAbort({
            sinks,
            signal,
            run: async (waitSignal) => {
              throwIfAborted(waitSignal);
              let onAbort: () => void = () => {};
              const cancelled = new Promise<never>((_resolve, reject) => {
                onAbort = () => reject(abortError(waitSignal));
                waitSignal.addEventListener('abort', onAbort, { once: true });
              });
              try {
                return await Promise.race([callbacks.onPlannerReply?.(reply), cancelled]);
              } finally {
                waitSignal.removeEventListener('abort', onAbort);
              }
            },
          }));
        if (answer === undefined || answer.trim() === '') {
          return {
            state,
            result: {
              kind: 'conversation',
              text: pending.text,
              questions: pending.questions,
              usage: null,
            },
          };
        }
        pending = {
          ...pending,
          answers: [...pending.answers, { reply: pending.text, answer }],
          answered: true,
        };
        state = transitionAndSave({ projectDir, sessionId }, state, {
          type: 'SET_PLANNER_CONVERSATION',
          conversation: pending,
        });
        appendMessage(
          { projectDir, sessionId },
          { role: 'user', phase: state.phase, text: answer },
        );
        publishUserMessage({ bus: wctx.bus, phase: state.phase }, answer);
        answeringQuestion = true;
      }
      if (seed === undefined || answeringQuestion) {
        answeringQuestion = answeringQuestion || state.interruptedStep === undefined;
        const onNativeSession =
          planner.capabilities.supportsSessionResume && Boolean(state.plannerSessionId);
        seed = {
          partial: pending.text,
          steer: onNativeSession
            ? pending.answers.at(-1)?.answer
            : pending.answers
                .map((turn) => `Planner: ${turn.reply}\nUser: ${turn.answer}`)
                .join('\n\n'),
        };
      }
    }
    const loop = await withContinuationLoop<PhaseCallResult>({
      ctx: { projectDir, sessionId, callbacks, bus: wctx.bus, signal, sinks },
      state,
      step: { kind: 'planner', call },
      ...(seed === undefined ? {} : { seed }),
      onStateChange: (s) => {
        state = s;
      },
      body: async ({ signal: callSignal, partial, steer, recordOutput }) => {
        const heartbeat = startPlannerHeartbeat(wctx.bus, state.phase, Date.now());
        if (opts.phaseHint) heartbeat.updatePhaseHint(opts.phaseHint);
        const stripper = createQuestionMarkerStripper();
        // A seat that still holds this step's session continues on it; a stateless
        // one gets the step's prompt back with the continuation trailing it.
        const continuing = partial !== undefined || steer !== undefined;
        const onNativeSession =
          planner.capabilities.supportsSessionResume &&
          typeof state.plannerSessionId === 'string' &&
          state.plannerSessionId !== '';
        const continuation: Pick<PhaseInputs, 'continuationTurn' | 'promptSuffix'> = !continuing
          ? {}
          : onNativeSession
            ? {
                continuationTurn: composePlannerContinuationTurn(
                  call,
                  steer,
                  answeringQuestion ? 'answer' : 'interrupted',
                ),
              }
            : {
                promptSuffix: answeringQuestion
                  ? `[User reply]\n${steer ?? ''}`
                  : continuationBlock({ partial, steer }),
              };
        answeringQuestion = false;
        // The prefix leads the phase prompt: the messages queued for this call and
        // the rejections the planner has to respect.
        let prefix = '';

        if (config.approval?.feedRejectionsToPlanner !== false) {
          try {
            const ledger = readEvidenceLedger({ projectDir, sessionId });
            if (ledger) {
              const rejectionCtx = buildRejectionContext(ledger);
              if (rejectionCtx.length > 0) {
                prefix = `${rejectionCtx}\n${prefix}`;
              }
            }
          } catch {
            // Best-effort: never fail the planner call because the ledger is unreadable.
          }
        }

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
        };

        try {
          const result = await planner.runPhase({
            call,
            projectDir,
            callbacks: plannerCallbacks,
            inputs: {
              ...inputs,
              ...continuation,
              ...(prefix === '' ? {} : { promptPrefix: prefix + (inputs.promptPrefix ?? '') }),
            },
          });
          heartbeat.updateTokens(plannerCallTokens(result.usage));
          return result;
        } finally {
          heartbeat.stop();
          // The stripper holds text that could still turn out to be a question marker. An
          // abort or a planner crash ends the call with that text unreleased, so the flush
          // has to run on every exit or the narration it holds never reaches the transcript.
          const rest = stripper.flush();
          if (rest.length > 0) textHandler(rest);
        }
      },
    });

    if (loop.value.kind === 'artifact') return { state, result: loop.value };
    state = addUsageAndSave(wctx, state, 'planner', loop.value.usage);
    state = transitionAndSave({ projectDir, sessionId }, state, {
      type: 'SET_PLANNER_CONVERSATION',
      conversation: {
        call,
        text: loop.value.text,
        questions: loop.value.questions,
        answers: state.pendingPlannerConversation?.answers ?? [],
        answered: false,
      },
    });
    seed = undefined;
  }
}

function plannerCallTokens(usage: TokenDelta | null): number {
  if (usage === null) return 0;
  return usage.inputTokens + usage.outputTokens;
}
