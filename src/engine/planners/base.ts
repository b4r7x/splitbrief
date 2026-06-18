import type { Task } from '../../core/schemas/task.js';
import type { InvokeResult } from '../runners/types.js';
import type { TokenDelta } from '../../core/schemas/tokens.js';
import type { Attachment } from '../../core/schemas/attachment.js';
import type { StructuredSummary } from '../../core/schemas/compaction.js';
import { error } from '../../utils/error.js';
import type {
  Planner,
  PlannerCallbacks,
  PlannerOutputCallbacks,
  PlanOptions,
  EscalateOptions,
  RegenerateOptions,
  PlanResult,
  EscalationResult,
  RegenerateResult,
  PhaseResult,
  PlannerCapabilities,
  PriorMessage,
  PlannerSummaryMessage,
  PlannerStructuredSummaryOptions,
  PlannerSummaryOptions,
  PlannerUserTurnOptions,
} from './types.js';
import { buildResearchPrompt } from '../spec/prompts/research.js';
import { buildSpecPrompt } from '../spec/prompts/spec.js';
import { buildPlanPrompt } from '../spec/prompts/plan.js';
import { buildTasksPrompt } from '../spec/prompts/tasks.js';
import { buildQuickPlanPrompt } from '../spec/prompts/quick-plan.js';
import { buildInstantPrompt } from '../spec/prompts/instant.js';
import {
  buildProjectLanguageContext,
  extractLanguageFromResearch,
} from '../spec/prompts/language-context.js';
import { parseTasksStrict } from '../spec/parser.js';
import { RESEARCH_FILE, SPEC_FILE, PLAN_FILE, TASKS_FILE } from '../../core/paths.js';
import { buildProjectContextMarkdown } from './context.js';
import { accumulateUsage } from '../streaming/token-usage.js';
import { DEFAULT_AVAILABILITY } from '../availability.js';
import { createTranscriptBuffer } from '../streaming/transcript-buffer.js';
import type { Phase } from '../../core/schemas/enums.js';
import { escalateFull, escalateHint } from './escalation.js';
import { formatRepoMapBlock, prepareInvokeArgs, runSinglePhasePlanning } from './single-phase.js';
import { summarize, summarizeStructured } from './summary.js';
import { toRunnerCallResult, toTokenDelta } from '../calls/projection.js';
import type { RunnerCallCompatibleResult } from '../calls/projection.js';
import type { RunnerCallContext, RunnerCallResult } from '../calls/types.js';

const PHASE_MAP: Partial<Record<string, Phase>> = {
  researching: 'researching',
  specifying: 'specifying',
  planning: 'planning',
  'generating-tasks': 'planning',
};

type PlannerArtifactPhase = Phase | 'generating-tasks';

type InternalInvokeFn = (opts: {
  prompt: string;
  projectDir: string;
  callContext: RunnerCallContext;
  callbacks: Pick<
    PlannerCallbacks,
    'onOutput' | 'onQuestion' | 'onSessionId' | 'onSessionExpired' | 'onCallEvent'
  >;
  priorMessages?: PriorMessage[] | undefined;
  images?: Attachment[] | undefined;
  signal?: AbortSignal | undefined;
  sandboxEnv?: NodeJS.ProcessEnv | undefined;
}) => Promise<RunnerCallCompatibleResult>;

const DEFAULT_BACKEND_KIND: RunnerCallContext['backendKind'] = 'cli';

let plannerBaseCallSequence = 0;

function createPlannerCallContext(
  config: Pick<PlannerBaseConfig, 'backendKind' | 'runnerName' | 'model'>,
  role: RunnerCallContext['role'],
): RunnerCallContext {
  return {
    callId: `planner-${++plannerBaseCallSequence}`,
    role,
    backendKind: config.backendKind ?? DEFAULT_BACKEND_KIND,
    ...(config.runnerName !== undefined && { runnerName: config.runnerName }),
    ...(config.model !== undefined && { model: config.model }),
  };
}

function requireCompletedCall(result: RunnerCallResult): RunnerCallResult {
  if (result.status === 'completed') return result;
  throw error('runner-call-failed', `Planner ${result.role} call ${result.status}`, {
    callId: result.callId,
    role: result.role,
    backendKind: result.backendKind,
    status: result.status,
    partial: result.partial,
    error: result.error,
  });
}

// invokeEscalate exists separately: Claude Code uses session-chaining for plan phases but one-shot for escalations.
export interface PlannerBaseConfig {
  invokePlan: InternalInvokeFn;
  invokeEscalate: InternalInvokeFn;
  backendKind?: RunnerCallContext['backendKind'];
  runnerName?: string | undefined;
  model?: string | undefined;
  isAvailable: () => Promise<boolean>;
  unavailabilityReason?: () => string | undefined;
  getVersion?: () => Promise<string | null>;
  capabilities: PlannerCapabilities;
  /**
   * How to determine whether escalateHint succeeded.
   * - 'text': non-empty stdout (API/streaming planners)
   * - 'files': git changed files (CLI/agent planners that write files directly)
   * Default: 'text'
   */
  hintSuccessMode?: 'text' | 'files';
  /**
   * How to determine whether escalateFull succeeded.
   * - 'text': extract code block from stdout (API/streaming planners)
   * - 'files': git changed files (agent planners that write files directly)
   * Default: 'text'
   */
  escalateFullMode?: 'text' | 'files';
  /** Override to read the artifact from disk when the backend writes files directly (e.g., agent planner). Falls back to stdout text when not provided. */
  readPhaseOutput?: (
    filename: string,
    resultText: string,
    projectDir: string,
    sessionId?: string,
  ) => string;
  escalateFullPostProcess?: (
    task: Task,
    result: InvokeResult,
    extracted: { code: string },
    projectDir: string,
  ) => EscalationResult;
  /**
   * When true, the backend handles `priorMessages` natively (e.g. API backends using an OpenAI
   * messages array). When false (default), the base layer prepends a CLI-format transcript
   * block to the prompt for the first planning phase.
   */
  consumesPriorMessages?: boolean;
  injectUserTurn?: (opts: PlannerUserTurnOptions) => Promise<TokenDelta | null>;
}
export function createPlannerBase(config: PlannerBaseConfig): Planner {
  const capabilities = config.capabilities;

  return {
    async plan(opts: PlanOptions): Promise<PlanResult> {
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
        const result = requireCompletedCall(
          toRunnerCallResult(
            callContext,
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
                onCallEvent: callbacks.onCallEvent,
              },
              ...extras,
              signal: callbacks.signal,
            }),
          ),
        );
        buffer.flush();
        const usageDelta = toTokenDelta(result.usage);
        if (usageDelta) usage = accumulateUsage(usage, usageDelta);
        const artifactText = config.readPhaseOutput
          ? config.readPhaseOutput(filename, result.text, projectDir, callbacks.sessionId)
          : result.text;
        const rawOutput = artifactText !== result.text ? result.text : undefined;
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
    },
    async quickPlan(opts: PlanOptions): Promise<PlanResult> {
      return runSinglePhasePlanning(
        config,
        (promptFeature, projectContext, languageContext) =>
          buildQuickPlanPrompt(promptFeature, projectContext, languageContext),
        opts.feature,
        opts.projectDir,
        opts.callbacks,
        opts.codebaseContext,
      );
    },
    async instantPlan(opts: PlanOptions): Promise<PlanResult> {
      return runSinglePhasePlanning(
        config,
        (promptFeature, projectContext, languageContext) =>
          buildInstantPrompt(promptFeature, projectContext, languageContext),
        opts.feature,
        opts.projectDir,
        opts.callbacks,
        opts.codebaseContext,
      );
    },

    async regenerate(opts: RegenerateOptions): Promise<RegenerateResult> {
      const { prompt, projectDir, callbacks } = opts;
      const callContext = createPlannerCallContext(config, 'planner');
      const result = requireCompletedCall(
        toRunnerCallResult(
          callContext,
          await config.invokeEscalate({
            prompt,
            projectDir,
            callContext,
            callbacks,
            signal: callbacks.signal,
          }),
        ),
      );
      return { text: result.text, usage: toTokenDelta(result.usage) };
    },

    async escalateHint(opts: EscalateOptions): Promise<EscalationResult> {
      return escalateHint(config, opts);
    },

    async escalateFull(opts: EscalateOptions): Promise<EscalationResult> {
      return escalateFull(config, opts);
    },

    async review(
      prompt: string,
      projectDir: string,
      callbacks: PlannerOutputCallbacks,
    ): Promise<{ text: string; usage: TokenDelta | null }> {
      const callContext = createPlannerCallContext(config, 'review');
      const result = requireCompletedCall(
        toRunnerCallResult(
          callContext,
          await config.invokeEscalate({
            prompt,
            projectDir,
            callContext,
            callbacks,
            signal: callbacks.signal,
          }),
        ),
      );
      return { text: result.text, usage: toTokenDelta(result.usage) };
    },

    async summarize(
      messages: PlannerSummaryMessage[],
      opts?: PlannerSummaryOptions | undefined,
    ): Promise<{ text: string; usage: TokenDelta | null }> {
      return summarize(config, messages, opts);
    },

    async summarizeStructured(
      messages: PlannerSummaryMessage[],
      opts?: PlannerStructuredSummaryOptions | undefined,
    ): Promise<{ text: string; structured: StructuredSummary | null; usage: TokenDelta | null }> {
      return summarizeStructured(config, messages, opts);
    },

    ...DEFAULT_AVAILABILITY,
    isAvailable: config.isAvailable,
    ...(config.unavailabilityReason && { unavailabilityReason: config.unavailabilityReason }),
    ...(config.getVersion && { getVersion: config.getVersion }),
    ...(config.injectUserTurn && { injectUserTurn: config.injectUserTurn }),
    capabilities,
  };
}
