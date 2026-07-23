import type { Task } from '../../core/schemas/task.js';
import type { InvokeResult } from '../runners/types.js';
import type { TokenDelta } from '../../core/schemas/tokens.js';
import type { Attachment } from '../../core/schemas/attachment.js';
import type { StructuredSummary } from '../../core/schemas/compaction.js';
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
  PlannerCapabilities,
  PriorMessage,
  PlannerSummaryMessage,
  PlannerStructuredSummaryOptions,
  PlannerSummaryOptions,
  PlannerUserTurnOptions,
} from './types.js';
import { buildQuickPlanPrompt } from '../spec/prompts/quick-plan.js';
import { buildInstantPrompt } from '../spec/prompts/instant.js';
import { DEFAULT_AVAILABILITY } from '../availability.js';
import { escalateFull, escalateHint } from './escalation.js';
import { runSinglePhasePlanning } from './single-phase.js';
import { runMultiPhasePlanning } from './multi-phase.js';
import { createPlannerCallContext } from './call-context.js';
import { summarize, summarizeStructured } from './summary.js';
import { toTokenDelta } from '../calls/projection.js';
import type { RunnerCallContext, RunnerCallResult } from '../calls/types.js';
import { requireCompletedCall } from './require-completed-call.js';

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
}) => Promise<RunnerCallResult>;

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
      return runMultiPhasePlanning(config, opts);
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
        await config.invokeEscalate({
          prompt,
          projectDir,
          callContext,
          callbacks,
          signal: callbacks.signal,
        }),
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
        await config.invokeEscalate({
          prompt,
          projectDir,
          callContext,
          callbacks,
          signal: callbacks.signal,
        }),
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
