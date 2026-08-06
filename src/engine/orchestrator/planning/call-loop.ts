import { createBusTextHandler, publishRunnerCallEvent, publishWarning } from '../events.js';
import { transitionAndSave } from '../state-ops.js';
import { createSessionExpiredHandler } from '../resume-context.js';
import { withContinuationLoop } from '../continuation.js';
import { readEvidenceLedger } from '../../../core/evidence/ledger-storage.js';
import { buildRejectionContext } from '../evidence/reporting.js';
import { startPlannerHeartbeat } from './heartbeat.js';
import { createQuestionMarkerStripper } from '../../parsers/question.js';
import { composeSteeredPrompt } from '../../implementers/types.js';
import type { PhaseResult, PlanResult, PlannerCallbacks } from '../../planners/types.js';
import type { TokenDelta } from '../../../core/schemas/tokens.js';
import type { PlannerCallRunResult, PlannerCallOptions } from './types.js';

export const MAX_CLARIFICATION_QUESTIONS = 5;

export async function runPlannerCallInContinuationLoop(
  opts: PlannerCallOptions,
): Promise<PlannerCallRunResult> {
  const {
    wctx,
    planner,
    feature,
    mode,
    skillsContext,
    codebaseContext,
    priorMessages,
    collectedQuestions,
    attachments,
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
  const unsubscribeHeartbeat = wctx.bus.subscribe((e) => {
    if (e.type === 'cost_update') {
      heartbeat.updateTokens((e.tokenUsage.plannerInput ?? 0) + (e.tokenUsage.plannerOutput ?? 0));
    }
  });

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
            config,
            resumeHolder,
          }),
          sessionId,
          persistTranscript: config.workflow.persistTranscript,
          signal: callSignal,
          ...(priorMessages && priorMessages.length > 0 ? { priorMessages } : {}),
          ...(callAttachments ? { attachments: callAttachments } : {}),
          ...(state.discoveredValidation !== undefined
            ? { discoveredValidation: state.discoveredValidation }
            : {}),
          ...(collectedQuestions
            ? {
                onQuestion: (questions) => {
                  for (const q of questions) {
                    if (collectedQuestions.length < MAX_CLARIFICATION_QUESTIONS) {
                      collectedQuestions.push(q);
                    }
                  }
                },
              }
            : {}),
        };

        if (mode === 'quick') {
          const quickPlanFn = planner.quickPlan ?? planner.plan;
          const runQuickCall = () =>
            quickPlanFn.call(planner, {
              feature: prompt,
              projectDir,
              callbacks: plannerCallbacks,
              codebaseContext,
            });
          let result = await runQuickCall();
          if (result.tasks.length === 0) {
            result = mergePlannerAttempts(result, await runQuickCall());
          }
          const rest = stripper.flush();
          if (rest.length > 0) textHandler(rest);
          return result;
        }
        const result = await planner.plan({
          feature: prompt,
          projectDir,
          callbacks: plannerCallbacks,
          skillsContext,
          codebaseContext,
        });
        const rest = stripper.flush();
        if (rest.length > 0) textHandler(rest);
        return result;
      },
    });

    return { state, result: loop.value };
  } finally {
    heartbeat.stop();
    unsubscribeHeartbeat();
  }
}

/**
 * Folds the zero-task retry into one result the caller can book once: tokens are summed
 * and phases are unioned by filename, with the retry winning a filename both attempts wrote.
 */
export function mergePlannerAttempts(first: PlanResult, retry: PlanResult): PlanResult {
  return {
    ...retry,
    usage: sumTokenDeltas(first.usage, retry.usage),
    phases: mergePhases(first.phases, retry.phases),
  };
}

function mergePhases(
  first: PhaseResult[] | undefined,
  retry: PhaseResult[] | undefined,
): PhaseResult[] | undefined {
  if (first === undefined || first.length === 0) return retry;
  if (retry === undefined || retry.length === 0) return first;
  const byFilename = new Map<string, PhaseResult>();
  for (const phase of first) byFilename.set(phase.filename, phase);
  for (const phase of retry) byFilename.set(phase.filename, phase);
  return [...byFilename.values()];
}

function sumTokenDeltas(first: TokenDelta | null, retry: TokenDelta | null): TokenDelta | null {
  if (first === null) return retry;
  if (retry === null) return first;
  const cacheReadTokens = sumOptional(first.cacheReadTokens, retry.cacheReadTokens);
  const cacheCreateTokens = sumOptional(first.cacheCreateTokens, retry.cacheCreateTokens);
  const reasoningTokens = sumOptional(first.reasoningTokens, retry.reasoningTokens);
  return {
    inputTokens: first.inputTokens + retry.inputTokens,
    outputTokens: first.outputTokens + retry.outputTokens,
    ...(cacheReadTokens !== undefined && { cacheReadTokens }),
    ...(cacheCreateTokens !== undefined && { cacheCreateTokens }),
    ...(reasoningTokens !== undefined && { reasoningTokens }),
  };
}

function sumOptional(first: number | undefined, retry: number | undefined): number | undefined {
  if (first === undefined && retry === undefined) return undefined;
  return (first ?? 0) + (retry ?? 0);
}
