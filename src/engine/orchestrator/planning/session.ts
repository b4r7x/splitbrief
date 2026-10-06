import { join } from 'node:path';
import { resolveImplementerProfiles } from '../../../core/config/accessors/implementer-profiles.js';
import { resolveApproveLevel } from '../../../core/config/runtime/resolve.js';
import {
  PLAN_FILE,
  PLAN_JSON_FILE,
  RESEARCH_FILE,
  SPEC_FILE,
  TASKS_FILE,
  sessionDir,
} from '../../../core/paths.js';
import {
  readSpecFile,
  readSpecFileOrEmpty,
  writeSpecFile,
  type SpecFileRef,
} from '../../../core/paths-io.js';
import {
  PLAN_ANSWER_JSON_SCHEMA,
  PlanAnswerSchema,
  PlanSchema,
  type PlanAnswer,
  type PlanProposal,
} from '../../../core/schemas/plan.js';
import type { ClarificationQuestion, PlannerReplyAnswer } from '../../../core/schemas/question.js';
import type { DiscoveredValidation, WorkflowState } from '../../../core/schemas/workflow.js';
import {
  isSessionConversation,
  questionsText,
  sessionConversation,
} from '../../../core/state/planning-conversation.js';
import { appendMessage } from '../../../core/sessions/log-writer.js';
import { parsePlanJson, writePlanJson } from '../../../core/sessions/plan-file.js';
import { resumeStep } from '../../../core/sessions/run-status.js';
import { DEFAULT_UNKNOWN_CONTEXT_LENGTH } from '../../../core/tokens/context-length.js';
import { readManifestCommands } from '../../../core/validation/manifest-commands.js';
import { detectStack } from '../../../core/validation/stacks/registry.js';
import { nowIso } from '../../../utils/format-time.js';
import { countNoun } from '../../../utils/pluralize.js';
import { buildRepoMap } from '../../codebase/repomap.js';
import { buildProjectContextMarkdown } from '../../planners/context.js';
import type { Planner, PriorMessage } from '../../planners/types.js';
import { fallbackInstruction, type RequestTypedResult } from '../../runners/typed-output.js';
import { formatTasks } from '../../spec/formatter.js';
import {
  blocksPlan,
  checkPlan,
  renderCheckNotes,
  type PlanCheckError,
} from '../../spec/plan-checks.js';
import { formatPlanMarkdown } from '../../spec/plan-markdown.js';
import { taskFromSpec } from '../../spec/plan-tasks.js';
import { buildProjectLanguageContext } from '../../spec/prompts/language-context.js';
import {
  MAX_QUESTION_ROUNDS,
  buildPlanSessionPrompt,
  planAnswersTurn,
  planFullTurn,
  planHistory,
  planRepairTurn,
  planRevisedTurn,
  type BuildSeat,
} from '../../spec/prompts/plan-session.js';
import { planConfirmations } from '../approval/confirm.js';
import { writeAndPublishArtifacts } from '../artifact-write.js';
import {
  profileEffectiveModelId,
  resolveProfileContextLength,
} from '../context-routing/context-length.js';
import { withContinuationLoop } from '../continuation.js';
import { persistApprovalEvidence } from '../evidence/persistence.js';
import {
  createBusTextHandler,
  publishPlannerStatus,
  publishRunnerCallEvent,
  publishUserMessage,
  publishWarning,
} from '../events.js';
import { askPlannerSession } from '../planner-session.js';
import { buildPlanSessionHaltRecoveryIssue } from '../recovery/builders/planner.js';
import { buildSeatProtocolErrorRecoveryIssue } from '../recovery/builders/seat-protocol.js';
import { loadSeatSwapContext } from '../recovery/seat-swap-context.js';
import { closeRunIfOpen } from '../run/close.js';
import { addUsageAndSave, raisePendingRecovery, transitionAndSave } from '../state-ops.js';
import type { PlannerCallbacksContext } from '../types.js';
import { plannerRejectionContext, waitForPlannerReply } from './call-loop.js';
import { apiPlanningPacket } from './api-packet.js';
import { handlePlanningFailure } from './failure.js';
import { startPlannerHeartbeat } from './heartbeat.js';
import { estimatePlanContextFits } from './plan-context-fit.js';
import {
  runPlanSession,
  type PlanSessionOutcome,
  type PlanSessionUnanswered,
  type PlanTurn,
} from './plan-session.js';
import { drainAndFormat } from './queue-drain.js';
import { sanitizeDiscoveredValidation } from './sanitize-discovered-validation.js';
import type { PlanningPhaseOptions, PlanningPhaseResult, PlanningProducerResult } from './types.js';

type Terminal = Extract<PlanningPhaseResult, { disposition: 'terminal' }>;

/** What a plan is checked against: the build seat's context, the project, the run's skills. */
export type PlanCheckContext = Pick<
  PlannerCallbacksContext,
  'config' | 'projectDir' | 'modelCache' | 'detectedContextLength' | 'skillsContext'
>;

function buildSeat(wctx: PlanCheckContext): BuildSeat {
  const profile = resolveImplementerProfiles(wctx.config).defaultProfile;
  return {
    model: profileEffectiveModelId(profile),
    contextTokens: resolveProfileContextLength(
      profile,
      DEFAULT_UNKNOWN_CONTEXT_LENGTH,
      wctx.modelCache,
      wctx.detectedContextLength,
    ).contextLength,
  };
}

/**
 * What an older multi-step planning chain of this run wrote: its documents and the conversation it
 * was holding, its open question answered by `answer` when the run continued with one. A run that
 * already has `plan.json` wrote its documents itself.
 */
function earlierPlanning(
  ref: SpecFileRef,
  state: WorkflowState,
  answer: string | undefined,
): string | undefined {
  if (readSpecFile(ref, PLAN_JSON_FILE) !== null) return undefined;
  const documents = [RESEARCH_FILE, SPEC_FILE, PLAN_FILE, TASKS_FILE].flatMap((file) => {
    const text = readSpecFile(ref, file)?.trim();
    return text === undefined || text === '' ? [] : [`### ${file}\n${text}`];
  });
  const conversation = state.pendingPlannerConversation;
  if (conversation !== undefined && !isSessionConversation(conversation)) {
    const rounds = [
      ...conversation.answers,
      ...(conversation.answered
        ? []
        : [{ reply: conversation.text, answer: answer ?? '(not answered)' }]),
    ];
    documents.push(planHistory(rounds));
  }
  return documents.length === 0 ? undefined : documents.join('\n\n');
}

/**
 * The text of one planning session turn: `turn` places the session prompt in the turn that carries
 * it, and `priorMessages` is the transcript the call is sent with.
 */
export type PlanTurnText = (
  turn: (prompt: string) => string,
  priorMessages?: readonly PriorMessage[] | undefined,
) => Promise<string>;

/**
 * The session prompt every turn of a planning session carries, for the run and for `splitbrief
 * spec` alike. A planner that reads no files of its own gets the current source of what the request
 * names, measured against its context inside the very turn that is sent; any other planner reads the
 * project itself.
 */
export async function planTurnText(opts: {
  wctx: PlanCheckContext & Pick<PlannerCallbacksContext, 'sessionId' | 'signal'>;
  planner: Pick<Planner, 'resolvePlanningContext'>;
  feature: string;
  language: string | undefined;
  earlierPlanning?: string | undefined;
  steer?: string | undefined;
  onWarn: (message: string, details?: string) => void;
}): Promise<PlanTurnText> {
  const { wctx, planner } = opts;
  const { projectDir, config } = wctx;
  const repoMap =
    config.codebase?.enabled === false
      ? ''
      : await buildRepoMap(projectDir, {
          featureText: opts.feature,
          tokenBudget: config.codebase?.tokenBudget ?? 4000,
          onWarn: opts.onWarn,
          ...(config.codebase?.include && { include: config.codebase.include }),
          ...(config.codebase?.exclude && { exclude: config.codebase.exclude }),
        });
  const codebaseContext = repoMap === '' ? undefined : repoMap;
  const languageContext = buildProjectLanguageContext(projectDir, opts.language);
  const compose = (projectContext: string): string =>
    plannerRejectionContext(wctx) +
    buildPlanSessionPrompt({
      feature: opts.feature,
      projectContext,
      languageContext,
      build: buildSeat(wctx),
      skillsContext: wctx.skillsContext,
      codebaseContext,
      earlierPlanning: opts.earlierPlanning,
    });
  if (planner.resolvePlanningContext === undefined) {
    const prompt = compose(await buildProjectContextMarkdown(projectDir));
    return async (turn) => turn(prompt);
  }
  const context = await planner.resolvePlanningContext(wctx.signal);
  return async (turn, priorMessages) =>
    turn(
      compose(
        await apiPlanningPacket({
          projectDir,
          context,
          // A tool that refuses the native schema gets it as text, so the measure carries it too.
          compose: (packet) => turn(compose(packet)) + fallbackInstruction(PLAN_ANSWER_JSON_SCHEMA),
          request: opts.feature,
          earlierPlanning: opts.earlierPlanning,
          steer: opts.steer,
          priorMessages,
          repoMap: codebaseContext,
          skills: wctx.skillsContext,
        }),
      ),
    );
}

function discoveredValidation(plan: PlanProposal): DiscoveredValidation | undefined {
  const { validation } = plan;
  if (validation === null) return undefined;
  return {
    ...(validation.language !== null && { language: validation.language }),
    ...(validation.typecheck !== null && { typecheckCommand: validation.typecheck }),
    ...(validation.lint !== null && { lintCommand: validation.lint }),
    ...(validation.test !== null && { testCommand: validation.test }),
    ...(validation.testPattern !== null && { testPattern: validation.testPattern }),
  };
}

/**
 * One planning session on the run: the planner answers in typed JSON, questions wait in the
 * composer, and a plan that passes its checks lands as `plan.json` with `plan.md` and `tasks.md`
 * rendered from it. `lead` is what the user asked of this session: a planner on its own session
 * hears it once, and every full turn of any other planner carries it again.
 */
export async function runPlanningSession(
  opts: PlanningPhaseOptions,
  lead?: string | undefined,
): Promise<PlanningProducerResult> {
  const { wctx, planner } = opts;
  const { projectDir, sessionId, bus } = wctx;
  const ref = { projectDir, sessionId };
  let state = opts.state;
  const steer = wctx.continuation?.take(resumeStep(state))?.steer?.trim();
  // A run continued with a steer while its planner question waited: the steer is the answer.
  const conversation = state.pendingPlannerConversation;
  const steerAnswer =
    conversation !== undefined && !conversation.answered && steer ? steer : undefined;
  const pending = sessionConversation(state);
  const earlier = earlierPlanning(ref, state, pending === undefined ? steerAnswer : undefined);
  let resumedAnswer = pending === undefined ? undefined : steerAnswer;
  const standing = [lead, steerAnswer === undefined ? steer : undefined]
    .filter((part): part is string => part !== undefined && part !== '')
    .join('\n\n');
  // A session continued after a stop at its questions: a planner on its own session still holds
  // what the user asked of it, any other planner reads it again on every full turn.
  const fullStanding = [lead === undefined ? pending?.lead : undefined, standing]
    .filter((part): part is string => part !== undefined && part !== '')
    .join('\n\n');
  let standingHeard = false;
  let note = '';
  let images = opts.attachments;
  let priorMessages = wctx.resumeHolder?.messages;

  if (state.pendingPlannerConversation !== undefined && pending === undefined) {
    state = transitionAndSave(ref, state, { type: 'CLEAR_PLANNER_CONVERSATION' });
  }

  try {
    if (opts.beforeFirstCall && !(await opts.beforeFirstCall())) {
      return { disposition: 'terminal', state, outcome: 'cancelled' };
    }
    if (state.phase !== 'planning') {
      state = transitionAndSave(
        ref,
        state,
        state.phase === 'idle' ? { type: 'START' } : { type: 'BEGIN_PLANNING' },
      );
    }
    publishPlannerStatus(bus, state, 'running', { call: 'plan' });

    const turnText = await planTurnText({
      wctx,
      planner,
      feature: opts.feature,
      language: state.discoveredValidation?.language,
      earlierPlanning: earlier,
      steer: standing,
      onWarn: (message, details) =>
        bus.publish({
          type: 'warning',
          ts: Date.now(),
          phase: state.phase,
          message,
          ...(details === undefined ? {} : { details }),
        }),
    });

    const rounds = (): number => sessionConversation(state)?.answers.length ?? 0;

    const compose = async (
      turn: PlanTurn,
      onSession: boolean,
      interruptSteer: string | undefined,
      prior: readonly PriorMessage[] | undefined,
    ): Promise<string> => {
      const sessionBody = !onSession
        ? undefined
        : turn.kind === 'answers'
          ? planAnswersTurn(turn.reply.text, rounds())
          : turn.kind === 'repair'
            ? planRepairTurn(turn.errors)
            : lead !== undefined
              ? ''
              : undefined;
      const opening = sessionBody !== undefined && !standingHeard ? standing : '';
      const said = interruptSteer?.trim();
      const around = (body: string) =>
        [note, opening, body, said ? `The user says: ${said}` : '']
          .filter((part) => part !== '')
          .join('\n\n');
      if (sessionBody !== undefined) return around(sessionBody);
      return turnText(
        (prompt) =>
          around(
            planFullTurn(
              prompt,
              sessionConversation(state)?.answers ?? [],
              turn.kind === 'repair' ? turn : undefined,
              fullStanding,
            ),
          ),
        prior,
      );
    };

    const ask = async (turn: PlanTurn): Promise<RequestTypedResult<PlanAnswer>> => {
      if (turn.kind === 'answers') state = recordAnswers(wctx, state, turn.reply);
      if (turn.kind === 'repair') {
        publishWarning({
          bus,
          phase: state.phase,
          message: `The plan failed ${countNoun(turn.errors.length, 'check')}; it goes back to the planner once.`,
        });
      }
      const drained = drainAndFormat(projectDir, sessionId, state, bus);
      state = drained.state;
      note = [drained.prefix.trim(), note].filter((part) => part !== '').join('\n\n');

      const loop = await withContinuationLoop<RequestTypedResult<PlanAnswer>>({
        ctx: {
          projectDir,
          sessionId,
          callbacks: wctx.callbacks,
          bus,
          signal: wctx.signal,
          sinks: wctx.sinks,
        },
        state,
        step: { kind: 'planner', call: 'plan' },
        onStateChange: (next) => {
          state = next;
        },
        body: async ({ signal, steer: interruptSteer }) => {
          const heartbeat = startPlannerHeartbeat(bus, state.phase, Date.now());
          try {
            const asked = await askPlannerSession(
              {
                projectDir,
                sessionId,
                bus,
                planner,
                state,
                signal,
                onStateChange: (next) => {
                  state = next;
                },
              },
              {
                schema: PlanAnswerSchema,
                jsonSchema: PLAN_ANSWER_JSON_SCHEMA,
                schemaName: 'plan_result',
                ...(images !== undefined && { images }),
                ...(priorMessages !== undefined && { priorMessages }),
                compose: ({ onSession, priorMessages: prior }) =>
                  compose(turn, onSession, interruptSteer, prior),
                onCallEvent: (event) => {
                  if (event.type === 'call_started') heartbeat.updateCallId(event.callId);
                  publishRunnerCallEvent({ bus, phase: state.phase }, event);
                },
              },
            );
            return asked.result;
          } finally {
            heartbeat.stop();
          }
        },
      });
      // `onStateChange` already moved `state` with the loop, and the call may have moved it since:
      // an expired thread resets the session it names, and an answer saves the handle it returned.
      note = '';
      standingHeard = true;
      images = undefined;
      priorMessages = undefined;
      const answered = loop.value;
      state = addUsageAndSave(wctx, state, 'planner', answered.usage);
      return answered;
    };

    const answer = async (
      questions: readonly ClarificationQuestion[],
      round: number,
    ): Promise<string | PlannerReplyAnswer | undefined> => {
      let asked = sessionConversation(state);
      if (asked === undefined || asked.answered) {
        asked = {
          call: 'plan',
          text: questionsText(questions),
          questions: [...questions],
          answers: asked?.answers ?? [],
          answered: false,
          ...(fullStanding !== '' && { lead: fullStanding }),
        };
        state = transitionAndSave(ref, state, {
          type: 'SET_PLANNER_CONVERSATION',
          conversation: asked,
        });
        const intro = `Questions before the plan · round ${round} of ${MAX_QUESTION_ROUNDS}`;
        appendMessage(ref, { role: 'assistant', phase: state.phase, text: intro });
        createBusTextHandler({ bus, phase: state.phase }, { role: 'planner', content: 'plain' })(
          intro,
          { messageStart: true },
        );
      }
      if (resumedAnswer !== undefined) {
        const reply = resumedAnswer;
        resumedAnswer = undefined;
        return reply;
      }
      return waitForPlannerReply(wctx, asked);
    };

    const outcome = await runPlanSession({
      rounds: rounds(),
      ...(pending !== undefined && !pending.answered && { pending: pending.questions }),
      ask,
      answer,
      check: (plan) => checkFullPlan(wctx, plan),
    });
    return await settle(opts, state, outcome);
  } catch (err) {
    return handlePlanningFailure({ err, projectDir, sessionId, state, wctx });
  }
}

/** The answer joins the session's conversation before the call that carries it. */
function recordAnswers(
  wctx: PlannerCallbacksContext,
  state: WorkflowState,
  reply: PlannerReplyAnswer,
): WorkflowState {
  const ref = { projectDir: wctx.projectDir, sessionId: wctx.sessionId };
  const asked = sessionConversation(state);
  const next =
    asked === undefined
      ? state
      : transitionAndSave(ref, state, {
          type: 'SET_PLANNER_CONVERSATION',
          conversation: {
            ...asked,
            answers: [...asked.answers, { reply: asked.text, answer: reply.text }],
            answered: true,
          },
        });
  appendMessage(ref, {
    role: 'user',
    phase: next.phase,
    text: reply.text,
    ...(reply.qa.length > 0 && { qa: reply.qa }),
  });
  publishUserMessage({ bus: wctx.bus, phase: next.phase }, reply.text, reply.qa);
  return next;
}

async function settle(
  opts: PlanningPhaseOptions,
  state: WorkflowState,
  outcome: PlanSessionOutcome | PlanSessionUnanswered,
): Promise<PlanningProducerResult> {
  const { wctx } = opts;
  const { projectDir, sessionId, bus, config } = wctx;
  const ref = { projectDir, sessionId };
  const halt = (issue: Parameters<typeof raisePendingRecovery>[2]): Terminal => ({
    disposition: 'terminal',
    state: raisePendingRecovery({ ...ref, bus }, state, issue),
    outcome: 'halted',
  });

  switch (outcome.kind) {
    case 'plan':
      return { disposition: 'tasks-ready', ...compilePlan(wctx, state, outcome.plan) };
    case 'unanswered':
      return { disposition: 'terminal', state, outcome: 'input-required' };
    case 'questions-exhausted':
      return halt(
        buildPlanSessionHaltRecoveryIssue({
          reason: 'plan-questions-exhausted',
          phase: state.phase,
          message: `The planner asked a third round of questions; a session takes ${MAX_QUESTION_ROUNDS}.`,
          details: outcome.questions.map((question) => question.text),
          createdAt: nowIso(),
        }),
      );
    case 'checks-failed':
      return halt(
        buildPlanSessionHaltRecoveryIssue({
          reason: 'plan-checks-failed',
          phase: state.phase,
          message: 'The plan failed its checks again after one repair.',
          details: outcome.errors.map((error) => error.message),
          createdAt: nowIso(),
        }),
      );
    default: {
      const seatSwap = await loadSeatSwapContext({
        projectDir,
        seat: 'plan',
        runner: config.planner,
      });
      return halt(
        buildSeatProtocolErrorRecoveryIssue({
          error: outcome.error,
          phase: state.phase,
          ...(seatSwap !== undefined && { seatSwap }),
          createdAt: nowIso(),
        }),
      );
    }
  }
}

/** A plan that passed its checks becomes the run's plan and its tasks. */
function compilePlan(
  wctx: PlannerCallbacksContext,
  state: WorkflowState,
  plan: PlanProposal,
): { state: WorkflowState; tasks: WorkflowState['tasks'] } {
  const { projectDir, sessionId, bus, config } = wctx;
  const ref = { projectDir, sessionId };
  const tasks = plan.tasks.map((spec) => taskFromSpec(spec, projectDir));
  writePlanJson(ref, plan);
  writeAndPublishArtifacts({
    projectDir,
    sessionId,
    bus,
    phase: state.phase,
    metadata: wctx.metadata,
    items: [
      {
        kind: 'plan',
        text: formatPlanMarkdown(plan, renderCheckNotes(plan, config.validation.render)),
      },
      { kind: 'task-briefs', text: formatTasks(tasks) },
    ],
  });
  const manifest = readManifestCommands(projectDir);
  const stack = detectStack(projectDir, config.validation.stack);
  const discovered = sanitizeDiscoveredValidation(
    discoveredValidation(plan),
    { bus, phase: state.phase },
    { projectDir, config, manifest, stack },
  );
  let next = discovered === undefined ? state : { ...state, discoveredValidation: discovered };
  if (next.pendingPlannerConversation !== undefined) {
    next = transitionAndSave(ref, next, { type: 'CLEAR_PLANNER_CONVERSATION' });
  }
  next = transitionAndSave(ref, next, {
    type: 'PLAN_COMPILED',
    plan: PlanSchema.parse(plan),
    tasks,
  });
  return { state: next, tasks };
}

/**
 * Every check a plan must pass before it becomes the run's plan, the context fit of each task
 * included. A plan the user edited at the card passes the same checks as one the planner returned.
 */
export async function checkFullPlan(
  wctx: PlanCheckContext,
  plan: PlanProposal,
): Promise<readonly PlanCheckError[]> {
  return checkPlan(
    plan,
    wctx.projectDir,
    await estimatePlanContextFits(plan, {
      config: wctx.config,
      projectDir: wctx.projectDir,
      modelCache: wctx.modelCache,
      detectedContextLength: wctx.detectedContextLength,
      skillsContext: wctx.skillsContext,
    }),
    wctx.config.validation.render,
  );
}

/**
 * The user's edit of plan.json at the card. A plan that passes every check is compiled again; any
 * other text is put back as it was, and one warning names what was wrong with it.
 */
async function applyPlanEdit(
  wctx: PlannerCallbacksContext,
  state: WorkflowState,
  reviewed: string,
): Promise<WorkflowState> {
  const ref = { projectDir: wctx.projectDir, sessionId: wctx.sessionId };
  const edited = readSpecFileOrEmpty(ref, PLAN_JSON_FILE);
  if (edited === reviewed) return state;
  const parsed = parsePlanJson(edited);
  const errors =
    'plan' in parsed
      ? (await checkFullPlan(wctx, parsed.plan)).filter(blocksPlan).map((error) => error.message)
      : parsed.errors;
  if ('plan' in parsed && errors.length === 0) {
    wctx.bus.publish({
      type: 'plan_regenerated',
      ts: Date.now(),
      phase: state.phase,
      comment: `(edited ${PLAN_JSON_FILE})`,
    });
    return compilePlan(wctx, state, parsed.plan).state;
  }
  writeSpecFile(ref, PLAN_JSON_FILE, reviewed, null);
  publishWarning({
    bus: wctx.bus,
    phase: state.phase,
    message: `The edited plan was not applied: ${errors.join(' ')}`,
  });
  return state;
}

/**
 * The plan card: the plan waits for the user's approval, when the run asks for one, before the
 * build begins. Approving it confirms the protected operations it lists; typed text, or a message
 * still queued, is a correction the planning session answers with a new plan; an edit of plan.json
 * is checked and compiled. A run parked at the card reopens it here.
 */
export async function runPlanApproval(
  opts: PlanningPhaseOptions,
  state: WorkflowState,
): Promise<PlanningPhaseResult> {
  const { wctx } = opts;
  const { projectDir, sessionId, bus, signal } = wctx;
  const ref = { projectDir, sessionId };
  const cardPath = join(sessionDir(projectDir, sessionId), PLAN_FILE);
  let current = state;

  while (resolveApproveLevel(wctx.config) === 'plan') {
    if (current.phase !== 'reviewing-plan') {
      current = transitionAndSave(ref, current, { type: 'PLAN_DONE', tasks: current.tasks });
      publishPlannerStatus(bus, current, 'running');
    }
    if (signal?.aborted) return { disposition: 'terminal', state: current, outcome: 'cancelled' };
    const reviewed = readSpecFileOrEmpty(ref, PLAN_JSON_FILE);
    const queued = drainAndFormat(projectDir, sessionId, current, bus);
    current = queued.state;
    let correction = queued.prefix.trim();

    if (correction === '') {
      try {
        const confirmations = planConfirmations(current.tasks, projectDir, current.plan);
        const result = await wctx.callbacks.onApprovalNeeded(
          'plan',
          cardPath,
          confirmations.map((confirmation) => confirmation.actionDescription),
        );
        if (signal?.aborted)
          return { disposition: 'terminal', state: current, outcome: 'cancelled' };
        if (result.approved) {
          if (result.unattended !== true) {
            persistApprovalEvidence({
              wctx,
              state: current,
              decision: { allow: true, confirmApprovals: confirmations },
            });
          }
          bus.publish({ type: 'plan_approved', ts: Date.now(), phase: current.phase });
          break;
        }
        if (result.action === 'end-run') {
          current = (await closeRunIfOpen({ projectDir, sessionId, bus }, current)).state;
          publishPlannerStatus(bus, current, 'done');
          bus.publish({ type: 'plan_rejected', ts: Date.now(), phase: current.phase });
          return { disposition: 'terminal', state: current, outcome: 'closed' };
        }
        if (result.action === 'edit') {
          current = await applyPlanEdit(wctx, current, reviewed);
          continue;
        }
        if (result.action !== 'revise' || result.comment.trim() === '') continue;
        correction = result.comment.trim();
        if (result.recorded !== true) {
          appendMessage(ref, { role: 'user', phase: 'reviewing-plan', text: correction });
        }
      } catch (err) {
        return handlePlanningFailure({ err, projectDir, sessionId, state: current, wctx });
      }
    }

    bus.publish({
      type: 'plan_regenerated',
      ts: Date.now(),
      phase: current.phase,
      comment: correction,
    });
    current = transitionAndSave(ref, current, { type: 'CORRECT_PLAN', comment: correction });
    const revised = await runPlanningSession(
      { ...opts, state: current, attachments: undefined, beforeFirstCall: undefined },
      planRevisedTurn(reviewed, correction),
    );
    if (revised.disposition === 'terminal') return revised;
    current = revised.state;
  }

  current = transitionAndSave(ref, current, { type: 'BEGIN_IMPLEMENTATION' });
  return { disposition: 'ready-for-tasks', state: current, tasks: current.tasks };
}
