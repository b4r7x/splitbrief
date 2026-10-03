import type { Task } from '../../core/schemas/task.js';
import type { InvokeResult } from '../runners/types.js';
import type { TypedSchemaInput } from '../runners/typed-output.js';
import type { TypedOutputCapability } from '../../core/runners/cli-tool-catalog.js';
import type { TokenDelta } from '../../core/schemas/tokens.js';
import type { Attachment } from '../../core/schemas/attachment.js';
import type { StructuredSummary } from '../../core/schemas/compaction.js';
import type {
  Planner,
  PlannerCallbacks,
  PlannerOutputCallbacks,
  EscalateOptions,
  EscalationResult,
  PlannerCapabilities,
  PriorMessage,
  PlannerSummaryMessage,
  PlannerStructuredSummaryOptions,
  PlannerSummaryOptions,
  PlannerUserTurnOptions,
  PlannerUserTurnResult,
} from './types.js';
import { DEFAULT_AVAILABILITY } from '../availability.js';
import { escalateFull, escalateHint } from './escalation.js';
import { formatMessagesForCli } from '../streaming/format-messages.js';
import { createPlannerCallContext } from './call-context.js';
import { summarize, summarizeStructured } from './summary.js';
import { toTokenDelta } from '../calls/projection.js';
import type { RunnerCallContext, RunnerCallResult } from '../calls/types.js';
import { requireCompletedCall } from './require-completed-call.js';

type InvokeExtras = {
  priorMessages?: PriorMessage[];
  images?: Attachment[];
};

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

type InternalInvokeOptions = {
  prompt: string;
  projectDir: string;
  callContext: RunnerCallContext;
  callbacks: Pick<
    PlannerCallbacks,
    'onOutput' | 'onQuestion' | 'onSessionId' | 'onSessionExpired' | 'onCallEvent'
  >;
  priorMessages?: PriorMessage[] | undefined;
  images?: Attachment[] | undefined;
  schema?: TypedSchemaInput | undefined;
  signal?: AbortSignal | undefined;
  sandboxEnv?: NodeJS.ProcessEnv | undefined;
};

type InternalPlanInvokeFn = (opts: InternalInvokeOptions) => Promise<RunnerCallResult>;
// invokeEscalate exists separately: Claude Code uses session-chaining for plan phases but one-shot for escalations.
type InternalEscalateInvokeFn = (
  opts: InternalInvokeOptions & { accessMode: 'read-only' | 'write-files' },
) => Promise<RunnerCallResult>;

export interface PlannerBaseConfig {
  invokePlan: InternalPlanInvokeFn;
  invokeEscalate: InternalEscalateInvokeFn;
  backendKind?: RunnerCallContext['backendKind'];
  runnerName?: string | undefined;
  model?: string | undefined;
  isAvailable: () => Promise<boolean>;
  unavailabilityReason?: () => string | undefined;
  getVersion?: () => Promise<string | null>;
  capabilities: PlannerCapabilities;
  /** How a typed call reaches this backend; defaults to 'fallback'. */
  typedOutput?: TypedOutputCapability | undefined;
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
  injectUserTurn?: (opts: PlannerUserTurnOptions) => Promise<PlannerUserTurnResult>;
  resolvePlanningContext?: Planner['resolvePlanningContext'];
}
export function createPlannerBase(config: PlannerBaseConfig): Planner {
  const capabilities = config.capabilities;

  const planner: Planner = {
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
          accessMode: 'read-only',
          callbacks,
          signal: callbacks.signal,
        }),
      );
      return { text: result.text, usage: toTokenDelta(result.usage) };
    },

    typedCall: (ctx) => ({
      seat: ctx.seat,
      typedOutput: config.typedOutput ?? 'fallback',
      canResume: capabilities.supportsSessionResume,
      invoke: ({ prompt, schema }) => {
        const callContext = createPlannerCallContext(
          config,
          ctx.seat === 'planner' ? 'planner' : 'review',
        );
        // A planner answer is a turn on the planning thread the backend holds, so a repair
        // continues the thread that gave it; a review holds no session.
        if (ctx.seat === 'planner') {
          const { effectivePrompt, extras } = prepareInvokeArgs({
            prompt,
            priorMessages: ctx.priorMessages,
            images: ctx.images,
            consumesPriorMessages: config.consumesPriorMessages,
          });
          return config.invokePlan({
            prompt: effectivePrompt,
            projectDir: ctx.projectDir,
            callContext,
            callbacks: ctx.callbacks,
            signal: ctx.callbacks.signal,
            ...extras,
            ...(schema !== undefined && { schema }),
          });
        }
        return config.invokeEscalate({
          prompt,
          projectDir: ctx.projectDir,
          callContext,
          accessMode: 'read-only',
          callbacks: ctx.callbacks,
          signal: ctx.callbacks.signal,
          ...(schema !== undefined && { schema }),
        });
      },
    }),

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
    ...(config.resolvePlanningContext && {
      resolvePlanningContext: config.resolvePlanningContext,
    }),
    capabilities,
  };

  return planner;
}
