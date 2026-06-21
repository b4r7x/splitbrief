import { createBusTextHandler, publishRunnerCallEvent, publishWarning } from '../events.js';
import { transitionAndSave } from '../state-ops.js';
import { createSessionExpiredHandler } from '../resume-context.js';
import { withContinuationLoop } from '../continuation.js';
import { readEvidenceLedger } from '../../../core/evidence/ledger.js';
import { buildRejectionContext } from '../evidence/reporting.js';
import { startPlannerHeartbeat } from './heartbeat.js';
import type { PlanResult, PlannerCallbacks } from '../../planners/types.js';
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
  const conversational = planner.capabilities.supportsConversationalPlanning;
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
      ctx: { projectDir, sessionId, callbacks, signal, sinks },
      state,
      onStateChange: (s) => {
        state = s;
      },
      body: async ({ signal: callSignal, continuationPrompt, recordOutput }) => {
        let prompt = continuationPrompt ?? feature;

        if (config.approval?.feedRejectionsToPlanner !== false) {
          try {
            const ledger = readEvidenceLedger(projectDir, sessionId);
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
            textHandler(text);
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
          ...(mode === 'speckit' && conversational && collectedQuestions
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
          const result = await quickPlanFn.call(planner, {
            feature: prompt,
            projectDir,
            callbacks: plannerCallbacks,
            codebaseContext,
          });
          return { value: result };
        }
        const result = await planner.plan({
          feature: prompt,
          projectDir,
          callbacks: plannerCallbacks,
          skillsContext,
          codebaseContext,
        });
        return { value: result };
      },
    });

    state = loop.state;
    return { state, result: loop.value };
  } finally {
    heartbeat.stop();
    unsubscribeHeartbeat();
  }
}
