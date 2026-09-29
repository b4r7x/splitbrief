import type { Attachment } from '../../core/schemas/attachment.js';
import type { Phase } from '../../core/schemas/enums.js';
import { PLAN_FILE, RESEARCH_FILE, SPEC_FILE, TASKS_FILE } from '../../core/paths.js';
import type { RunnerCallContext } from '../calls/types.js';
import { toTokenDelta } from '../calls/projection.js';
import { formatMessagesForCli } from '../streaming/format-messages.js';
import { createTranscriptBuffer } from '../streaming/transcript-buffer.js';
import { admitPlanningArtifact } from '../spec/planning-artifact-admission.js';
import { isPlannerDocument } from '../../core/pipeline-spec/planner-documents.js';
import { extractQuestionsFromStream } from '../parsers/question.js';
import type { ClarificationQuestion } from '../../core/schemas/question.js';
import { error } from '../../utils/error.js';
import { buildPlanPrompt } from '../spec/prompts/plan.js';
import { buildQuickPlanPrompt } from '../spec/prompts/quick-plan.js';
import { buildResearchPrompt } from '../spec/prompts/research.js';
import { buildSpecPrompt } from '../spec/prompts/spec.js';
import { buildTasksPrompt } from '../spec/prompts/tasks.js';
import { parseTasksStrict } from '../spec/tasks/parse.js';
import { createPlannerCallContext } from './call-context.js';
import { normalizePlannerPhase } from './normalize.js';
import { requireCompletedCall } from './require-completed-call.js';
import { buildApiPlanningContext, type ApiPlanningArtifact } from './api-context.js';
import { buildProjectContext } from './context.js';
import { apiContextError } from '../providers/api-context-diagnostic.js';
import {
  apiBudgetError,
  BASE_OUTPUT_RESERVE_TOKENS,
  measureApiBudget,
} from '../providers/api-budget.js';
import type { ApiRuntimeContext } from '../providers/runtime-context.js';
import { assertNever } from '../../utils/type-guards.js';
import type {
  PhaseCallResult,
  PhaseInputs,
  PlannerArtifactLogicalName,
  PlannerCallbacks,
  PlannerDocumentCall,
  PlannerInvokeResult,
  PriorMessage,
  RunPhaseInput,
} from './types.js';

export type PhaseRunnerConfig = {
  invokePlan: (opts: {
    prompt: string;
    apiContext?: ApiRuntimeContext | undefined;
    projectDir: string;
    callContext: RunnerCallContext;
    callbacks: Pick<
      PlannerCallbacks,
      'onOutput' | 'onQuestion' | 'onSessionId' | 'onSessionExpired' | 'sessionId' | 'onCallEvent'
    >;
    priorMessages?: PriorMessage[] | undefined;
    images?: Attachment[] | undefined;
    artifactFile?: string | undefined;
    signal?: AbortSignal | undefined;
  }) => Promise<PlannerInvokeResult>;
  backendKind?: RunnerCallContext['backendKind'];
  runnerName?: string | undefined;
  model?: string | undefined;
  consumesPriorMessages?: boolean;
  /**
   * Input-token allocation for the explicitly assembled PLAN context packet.
   * Set by a seat that has no filesystem of its own, so everything it may rely
   * on has to be supplied in the prompt; absent leaves the phase prompt as the
   * backend's own tools already build it.
   */
  planningContextBudget?: number | undefined;
  resolvePlanningContext?: ((signal?: AbortSignal) => Promise<ApiRuntimeContext>) | undefined;
};

const CALL_PHASE = {
  research: 'researching',
  spec: 'specifying',
  plan: 'planning',
  tasks: 'planning',
} as const satisfies Record<PlannerDocumentCall, Phase>;

const CALL_ARTIFACT = {
  research: RESEARCH_FILE,
  spec: SPEC_FILE,
  plan: PLAN_FILE,
  tasks: TASKS_FILE,
} as const satisfies Record<PlannerDocumentCall, PlannerArtifactLogicalName>;

type InvokeExtras = {
  priorMessages?: PriorMessage[];
  images?: Attachment[];
};

function formatRepoMapBlock(codebaseContext: string | undefined): string {
  return codebaseContext ? `<repo-map>\n${codebaseContext}\n</repo-map>\n\n` : '';
}

export function prepareInvokeArgs(opts: {
  prompt: string;
  priorMessages: PriorMessage[] | undefined;
  images: Attachment[] | undefined;
  consumesPriorMessages: boolean | undefined;
}): { effectivePrompt: string; extras: InvokeExtras } {
  const { prompt, priorMessages, images, consumesPriorMessages } = opts;
  const hasPrior = priorMessages !== undefined && priorMessages.length > 0;
  const effectivePrompt =
    hasPrior && !consumesPriorMessages ? formatMessagesForCli(priorMessages) + prompt : prompt;
  const hasImages = images !== undefined && images.length > 0;
  const extras: InvokeExtras = {
    ...(consumesPriorMessages && hasPrior ? { priorMessages } : {}),
    ...(hasImages ? { images } : {}),
  };
  return { effectivePrompt, extras };
}

function buildPhasePrompt(call: PlannerDocumentCall, inputs: PhaseInputs): string {
  const repoMap = formatRepoMapBlock(inputs.codebaseContext);
  const body = ((): string => {
    if (inputs.continuationTurn !== undefined) return inputs.continuationTurn;
    switch (call) {
      case 'research':
        return (
          repoMap + buildResearchPrompt(inputs.feature, inputs.projectContext, inputs.skillsContext)
        );
      case 'spec':
        return buildSpecPrompt(
          inputs.feature,
          inputs.research ?? '',
          inputs.languageContext,
          inputs.skillsContext,
        );
      case 'plan': {
        const spec = inputs.spec ?? '';
        return buildPlanPrompt({
          spec: { content: spec, hasClarifications: spec.includes('## Clarifications') },
          projectContext: inputs.projectContext,
          skillsContext: inputs.skillsContext,
          languageContext: inputs.languageContext,
        });
      }
      case 'tasks':
        return inputs.quickPlan
          ? repoMap +
              buildQuickPlanPrompt({
                feature: inputs.feature,
                projectContext: inputs.projectContext,
                languageContext: inputs.languageContext,
                skillsContext: inputs.skillsContext,
                trivial: inputs.quickPlan.trivial,
              })
          : buildTasksPrompt({
              spec: inputs.spec ?? '',
              plan: inputs.plan ?? '',
              languageContext: inputs.languageContext,
              skillsContext: inputs.skillsContext,
            });
      default:
        return assertNever(call);
    }
  })();
  const led = inputs.promptPrefix ? inputs.promptPrefix + body : body;
  return inputs.promptSuffix ? `${led}\n\n${inputs.promptSuffix}` : led;
}

/**
 * The evidence a seat with no filesystem of its own is given for one call:
 * project instructions, the artifacts the step declares, the current source of
 * every path they name, and a named list of everything that was not read. An
 * incomplete or oversized packet refuses here — before any call is dispatched —
 * so the step stays where it is and the run's existing recovery answers it.
 */
async function supplyPlanningContext(opts: {
  call: PlannerDocumentCall;
  projectDir: string;
  inputs: PhaseInputs;
  priorMessages: PriorMessage[] | undefined;
  budget: number;
  model: string | undefined;
  context?: ApiRuntimeContext | undefined;
}): Promise<string> {
  const { call, projectDir, inputs, model } = opts;
  // A declared input the step did not receive is missing evidence, not absence:
  // the key is present exactly when the step names the artifact.
  const declared: [string, string | undefined][] = [
    [RESEARCH_FILE, inputs.research],
    [SPEC_FILE, inputs.spec],
    [PLAN_FILE, inputs.plan],
  ];
  const artifacts: ApiPlanningArtifact[] = declared
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([name, text]) => ({ name, text, required: true }));

  const steer = [inputs.promptPrefix, inputs.promptSuffix, inputs.continuationTurn]
    .filter((part): part is string => part !== undefined && part !== '')
    .join('\n');

  const embeddedArtifacts: readonly string[] = {
    research: [],
    spec: [RESEARCH_FILE],
    plan: [SPEC_FILE],
    tasks: [SPEC_FILE, PLAN_FILE],
  }[call];
  const usesPhaseArtifacts =
    inputs.continuationTurn === undefined && !(call === 'tasks' && inputs.quickPlan !== undefined);
  const additionalArtifacts = artifacts
    .filter(({ name }) => !usesPhaseArtifacts || !embeddedArtifacts.includes(name))
    .map(({ name, text }) => `## Supplied ${name}\n${text}`)
    .join('\n\n');
  const phasePrompt = buildPhasePrompt(call, { ...inputs, projectContext: '' });
  const embedsRequest =
    inputs.continuationTurn === undefined &&
    (call === 'research' ||
      call === 'spec' ||
      (call === 'tasks' && inputs.quickPlan !== undefined));
  const request = embedsRequest ? '' : `## Original request\n${inputs.feature}`;
  const promptWithPacket = (packet: string) =>
    [phasePrompt, request, additionalArtifacts, packet].filter((part) => part !== '').join('\n\n');
  const context = opts.context;
  const measure =
    context === undefined
      ? undefined
      : (packet: string) =>
          measureApiBudget({
            context,
            messages: [
              ...(opts.priorMessages ?? []),
              { role: 'user', content: promptWithPacket(packet) },
            ],
            role: 'plan',
          });
  const minimum = measure?.('');
  if (minimum?.kind === 'insufficient' && minimum.reason === 'output') {
    throw apiBudgetError.contextInsufficient('planner', minimum, model, {
      budgetSource: context?.budgetSource,
    });
  }

  const packet = await buildApiPlanningContext({
    projectDir,
    project: await buildProjectContext(projectDir),
    request: inputs.feature,
    artifacts,
    ...(steer !== '' && { steer }),
    ...(opts.priorMessages !== undefined && { priorMessages: opts.priorMessages }),
    ...(inputs.codebaseContext !== undefined && { repoMap: inputs.codebaseContext }),
    repoMapInPrompt: call === 'research' || (call === 'tasks' && inputs.quickPlan !== undefined),
    ...(inputs.skillsContext !== undefined && { skills: inputs.skillsContext }),
    availableTokens: opts.budget,
    ...(measure !== undefined && {
      measureInput: (packet: string) => {
        const measurement = measure(packet);
        return measurement.inputEstimate + measurement.estimationMargin;
      },
    }),
    ...(model !== undefined && { model }),
  });
  if (packet.kind === 'insufficient-context') {
    throw apiContextError({
      code: 'insufficient-context',
      seat: 'plan',
      cause: packet.cause,
      missingSections: [...packet.missingSections],
      ...(model !== undefined && { model }),
      requiredTokens: packet.requiredTokens,
      availableTokens: packet.availableTokens,
    });
  }
  return promptWithPacket(packet.text);
}

/**
 * One planner call per invocation. The returned function is bound to a planner
 * instance, so the prior transcript and the attachments are injected into the
 * first call that instance makes and never repeated on the calls that follow —
 * unless the seat drops that call's session as expired: the session took none of
 * it, so the next call, on a fresh session, carries both again.
 */
export function createPhaseRunner(
  config: PhaseRunnerConfig,
): (input: RunPhaseInput) => Promise<PhaseCallResult> {
  let priorInjected = false;
  let imagesInjected = false;

  return async function runPhase({
    call,
    projectDir,
    inputs,
    callbacks,
  }: RunPhaseInput): Promise<PhaseCallResult> {
    const phase = CALL_PHASE[call];
    const logicalName = CALL_ARTIFACT[call];
    callbacks.onPhase?.(phase);

    const buffer = createTranscriptBuffer({
      projectDir,
      sessionId: callbacks.sessionId ?? '',
      phase,
    });
    // The stream reaches the transcript log once the call settles: a reply is the planner's turn,
    // but a document is the step's artifact, which later calls are handed as their input.
    const streamed: string[] = [];
    const logStreamed = (): void => {
      for (const chunk of streamed) buffer.append(chunk);
    };

    const priorMessages = priorInjected ? undefined : inputs.priorMessages;
    priorInjected = true;
    const pendingImages = inputs.attachments;
    const images =
      !imagesInjected && pendingImages && pendingImages.length > 0 ? pendingImages : undefined;
    imagesInjected = true;

    const apiContext = await config.resolvePlanningContext?.(callbacks.signal);
    const budget =
      apiContext === undefined
        ? config.planningContextBudget
        : Math.max(0, apiContext.applicationContextTokens - BASE_OUTPUT_RESERVE_TOKENS);
    const prompt =
      budget === undefined
        ? buildPhasePrompt(call, inputs)
        : await supplyPlanningContext({
            call,
            projectDir,
            inputs,
            priorMessages,
            budget,
            context: apiContext,
            model: config.model,
          });

    const { effectivePrompt, extras } = prepareInvokeArgs({
      prompt,
      priorMessages,
      images,
      consumesPriorMessages: config.consumesPriorMessages,
    });

    const callContext = createPlannerCallContext(config, 'planner');
    const streamedQuestions = new Map<string, ClarificationQuestion>();
    let result: PlannerInvokeResult;
    try {
      result = requireCompletedCall(
        await config.invokePlan({
          prompt: effectivePrompt,
          apiContext,
          projectDir,
          callContext,
          callbacks: {
            onOutput: (text) => {
              callbacks.onOutput(text);
              streamed.push(text);
            },
            onQuestion: (questions) => {
              for (const question of questions) streamedQuestions.set(question.id, question);
              callbacks.onQuestion?.(questions);
            },
            onSessionId: callbacks.onSessionId,
            onSessionExpired: (previousId) => {
              priorInjected = false;
              imagesInjected = false;
              callbacks.onSessionExpired?.(previousId);
            },
            sessionId: callbacks.sessionId,
            onCallEvent: callbacks.onCallEvent,
          },
          ...extras,
          artifactFile: logicalName,
          signal: callbacks.signal,
        }),
      );
    } catch (err) {
      logStreamed();
      if (callbacks.signal?.aborted) {
        buffer.flushInterrupted();
      } else {
        buffer.flush();
      }
      throw err;
    }

    const text = result.text;
    for (const question of extractQuestionsFromStream(text))
      streamedQuestions.set(question.id, question);
    const questions = [...streamedQuestions.values()].slice(0, 5);
    if (text.trim() === '' && questions.length === 0) {
      if (call === 'spec' || call === 'plan') {
        admitPlanningArtifact({ phase: CALL_PHASE[call], filename: logicalName, text });
      }
      throw error('planner-empty-output', 'The planner returned no text or questions.', { call });
    }
    const taskWarnings: string[] = [];
    const tasks =
      call === 'tasks'
        ? parseTasksStrict(text, (message) => taskWarnings.push(message))
        : undefined;
    if (
      questions.length > 0 ||
      (call === 'tasks' ? tasks?.length === 0 : !isPlannerDocument(call, text))
    ) {
      logStreamed();
      buffer.flush();
      return { kind: 'conversation', text, usage: toTokenDelta(result.usage), questions };
    }
    for (const warning of taskWarnings) callbacks.onWarning?.(warning);
    if (call === 'spec' || call === 'plan') {
      admitPlanningArtifact({ phase: CALL_PHASE[call], filename: logicalName, text });
    }

    return {
      kind: 'artifact',
      text,
      usage: toTokenDelta(result.usage),
      artifact: normalizePlannerPhase({ result, callContext, logicalName, text }),
      ...(tasks === undefined ? {} : { tasks }),
    };
  };
}
