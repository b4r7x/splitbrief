import type { Attachment } from '../../core/schemas/attachment.js';
import type { Phase } from '../../core/schemas/enums.js';
import { PLAN_FILE, RESEARCH_FILE, SPEC_FILE, TASKS_FILE } from '../../core/paths.js';
import type { RunnerCallContext } from '../calls/types.js';
import { toTokenDelta } from '../calls/projection.js';
import { formatMessagesForCli } from '../streaming/format-messages.js';
import { createTranscriptBuffer } from '../streaming/transcript-buffer.js';
import { admitPlanningArtifact } from '../spec/planning-artifact-admission.js';
import { buildPlanPrompt } from '../spec/prompts/plan.js';
import { buildQuickPlanPrompt } from '../spec/prompts/quick-plan.js';
import { buildResearchPrompt } from '../spec/prompts/research.js';
import { buildSpecPrompt } from '../spec/prompts/spec.js';
import { buildTasksPrompt } from '../spec/prompts/tasks.js';
import { parseTasksStrict } from '../spec/tasks/parse.js';
import { createPlannerCallContext } from './call-context.js';
import { normalizePlannerPhase } from './normalize.js';
import { requireCompletedCall } from './require-completed-call.js';
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

function prepareInvokeArgs(opts: {
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
 * One planner call per invocation. The returned function is bound to a planner
 * instance, so the prior transcript and the attachments are injected into the
 * first call that instance makes and never repeated on the calls that follow.
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

    const priorMessages = priorInjected ? undefined : inputs.priorMessages;
    priorInjected = true;
    const pendingImages = inputs.attachments;
    const images =
      !imagesInjected && pendingImages && pendingImages.length > 0 ? pendingImages : undefined;
    imagesInjected = true;

    const { effectivePrompt, extras } = prepareInvokeArgs({
      prompt: buildPhasePrompt(call, inputs),
      priorMessages,
      images,
      consumesPriorMessages: config.consumesPriorMessages,
    });

    const callContext = createPlannerCallContext(config, 'planner');
    let result: PlannerInvokeResult;
    try {
      result = requireCompletedCall(
        await config.invokePlan({
          prompt: effectivePrompt,
          projectDir,
          callContext,
          callbacks: {
            onOutput: (text) => {
              callbacks.onOutput(text);
              buffer.append(text);
            },
            onQuestion: callbacks.onQuestion,
            onSessionId: callbacks.onSessionId,
            onSessionExpired: callbacks.onSessionExpired,
            sessionId: callbacks.sessionId,
            onCallEvent: callbacks.onCallEvent,
          },
          ...extras,
          artifactFile: logicalName,
          signal: callbacks.signal,
        }),
      );
    } catch (err) {
      if (callbacks.signal?.aborted) {
        buffer.flushInterrupted();
      } else {
        buffer.flush();
      }
      throw err;
    }
    buffer.flush();

    const text = result.text;
    if (call === 'spec' || call === 'plan') {
      admitPlanningArtifact({ phase: CALL_PHASE[call], filename: logicalName, text });
    }

    return {
      text,
      usage: toTokenDelta(result.usage),
      artifact: normalizePlannerPhase({ result, callContext, logicalName, text }),
      ...(call === 'tasks' ? { tasks: parseTasksStrict(text, callbacks.onWarning) } : {}),
    };
  };
}
