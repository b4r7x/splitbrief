import type { Attachment } from '../../core/schemas/attachment.js';
import type { TokenDelta } from '../../core/schemas/tokens.js';
import type { Phase } from '../../core/schemas/enums.js';
import type {
  PlanOptions,
  PlanResult,
  PlannerCallbacks,
  PhaseResult,
  PriorMessage,
} from './types.js';
import { RESEARCH_FILE, SPEC_FILE, PLAN_FILE, TASKS_FILE } from '../../core/paths.js';
import { buildResearchPrompt } from '../spec/prompts/research.js';
import { buildSpecPrompt } from '../spec/prompts/spec.js';
import { buildPlanPrompt } from '../spec/prompts/plan.js';
import { buildTasksPrompt } from '../spec/prompts/tasks.js';
import {
  buildProjectLanguageContext,
  extractLanguageFromResearch,
} from '../spec/prompts/language-context.js';
import { parseTasksStrict } from '../spec/tasks/parse.js';
import { buildProjectContextMarkdown } from './context.js';
import { accumulateTokenUsage } from '../calls/usage.js';
import { toTokenDelta } from '../calls/projection.js';
import { createTranscriptBuffer } from '../streaming/transcript-buffer.js';
import type { RunnerCallContext, RunnerCallResult } from '../calls/types.js';
import { requireCompletedCall } from './require-completed-call.js';
import { formatRepoMapBlock, prepareInvokeArgs } from './single-phase.js';
import { createPlannerCallContext } from './call-context.js';
import { admitPlanningArtifact } from '../spec/planning-artifact-admission.js';

type MultiPhaseConfig = {
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
  }) => Promise<RunnerCallResult>;
  backendKind?: RunnerCallContext['backendKind'];
  runnerName?: string | undefined;
  model?: string | undefined;
  readPhaseOutput?: (
    filename: string,
    resultText: string,
    projectDir: string,
    sessionId?: string,
  ) => string;
  consumesPriorMessages?: boolean;
};

const PHASE_MAP: Partial<Record<string, Phase>> = {
  researching: 'researching',
  specifying: 'specifying',
  planning: 'planning',
  'generating-tasks': 'planning',
};

type PlannerArtifactPhase = Phase | 'generating-tasks';

export async function runMultiPhasePlanning(
  config: MultiPhaseConfig,
  opts: PlanOptions,
): Promise<PlanResult> {
  const { feature, projectDir, callbacks, skillsContext, codebaseContext } = opts;
  const projectContext = await buildProjectContextMarkdown(projectDir);
  const repoMapBlock = formatRepoMapBlock(codebaseContext);
  let usage: TokenDelta | null = null;
  const phases: PhaseResult[] = [];

  let priorInjected = false;
  let imagesInjected = false;
  const pendingImages = callbacks.attachments;
  async function runPhase(
    phase: PlannerArtifactPhase,
    prompt: string,
    filename: string,
  ): Promise<string> {
    const plannerPhase = PHASE_MAP[phase];
    if (plannerPhase) callbacks.onPhase?.(plannerPhase);
    const buffer = createTranscriptBuffer({
      projectDir,
      sessionId: callbacks.sessionId ?? '',
      phase: plannerPhase,
      persistTranscript: callbacks.persistTranscript ?? true,
    });

    const priorMessages = !priorInjected ? callbacks.priorMessages : undefined;
    priorInjected = true;
    const images =
      !imagesInjected && pendingImages && pendingImages.length > 0 ? pendingImages : undefined;
    imagesInjected = true;

    const { effectivePrompt, extras } = prepareInvokeArgs({
      prompt,
      priorMessages,
      images,
      consumesPriorMessages: config.consumesPriorMessages,
    });

    const callContext = createPlannerCallContext(config, 'planner');
    let result: RunnerCallResult;
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
          artifactFile: filename,
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
    const usageDelta = toTokenDelta(result.usage);
    if (usageDelta) usage = accumulateTokenUsage(usage, usageDelta);
    const artifactText = config.readPhaseOutput
      ? config.readPhaseOutput(filename, result.text, projectDir, callbacks.sessionId)
      : result.text;
    const rawOutput = artifactText !== result.text ? result.text : undefined;
    if (phase === 'specifying' || phase === 'planning') {
      admitPlanningArtifact({ phase, filename, text: artifactText });
    }
    phases.push({ text: artifactText, filename, rawOutput });
    return artifactText;
  }

  const research = await runPhase(
    'researching',
    repoMapBlock + buildResearchPrompt(feature, projectContext, skillsContext),
    RESEARCH_FILE,
  );
  const languageContext = buildProjectLanguageContext(
    projectDir,
    extractLanguageFromResearch(research) ?? callbacks.discoveredValidation?.language,
  );
  const spec = await runPhase(
    'specifying',
    buildSpecPrompt(feature, research, languageContext),
    SPEC_FILE,
  );
  const plan = await runPhase(
    'planning',
    buildPlanPrompt(
      { content: spec, hasClarifications: spec.includes('## Clarifications') },
      projectContext,
      skillsContext,
      languageContext,
    ),
    PLAN_FILE,
  );
  const tasksMarkdown = await runPhase(
    'generating-tasks',
    buildTasksPrompt(spec, plan, languageContext),
    TASKS_FILE,
  );

  const tasks = parseTasksStrict(tasksMarkdown, callbacks.onWarning);

  return { spec, plan, tasks, usage, phases };
}
