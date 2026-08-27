import { createBusTextHandler, publishRunnerCallEvent, publishWarning } from '../events.js';
import { transitionAndSave } from '../state-ops.js';
import { createSessionExpiredHandler } from '../resume-context.js';
import { workflowAuthority } from '../run/authority.js';
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
import { zeroTaskRetryPrompt } from '../../spec/prompts/zero-task-retry.js';

const MAX_CLARIFICATION_QUESTIONS = 5;

export function createClarificationQuestionCollector(
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
            config,
            resumeHolder,
            authority: workflowAuthority(wctx),
          }),
          sessionId,
          persistTranscript: config.workflow.persistTranscript,
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
          if (mode === 'quick') {
            const quickPlanFn = planner.quickPlan ?? planner.plan;
            const runQuickCall = (callPrompt: string, callCallbacks: PlannerCallbacks) =>
              quickPlanFn.call(planner, {
                feature: callPrompt,
                projectDir,
                callbacks: callCallbacks,
                codebaseContext,
              });
            const parseDiagnostics: string[] = [];
            let result = await runQuickCall(prompt, {
              ...plannerCallbacks,
              onWarning: (message) => {
                parseDiagnostics.push(message);
                plannerCallbacks.onWarning?.(message);
              },
            });
            heartbeat.updateTokens(plannerCallTokens(result.usage));
            if (result.tasks.length === 0) {
              const retry = await runQuickCall(
                zeroTaskRetryPrompt(prompt, parseDiagnostics),
                plannerCallbacks,
              );
              heartbeat.updateTokens(plannerCallTokens(retry.usage));
              result = mergePlannerAttempts(result, retry);
            }
            return result;
          }
          const result = await planner.plan({
            feature: prompt,
            projectDir,
            callbacks: plannerCallbacks,
            skillsContext,
            codebaseContext,
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

/**
 * Folds the zero-task retry into one result the caller can book once: tokens are summed
 * (bounded evidence aggregation) but the retry is the terminal accepted attempt, so it is
 * the sole phase owner — the earlier zero-task attempt contributes no promotable phase.
 */
export function mergePlannerAttempts(first: PlanResult, retry: PlanResult): PlanResult {
  return {
    ...retry,
    usage: sumTokenDeltas(first.usage, retry.usage),
    phases: retry.phases,
  };
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
