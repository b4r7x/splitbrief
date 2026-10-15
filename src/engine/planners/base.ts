import type { TypedSchemaInput } from '../runners/typed-output.js';
import {
  CLI_TOOL_CATALOG,
  isCliToolId,
  type TypedOutputCapability,
} from '../../core/runners/cli-tool-catalog.js';
import type { TokenDelta } from '../../core/schemas/tokens.js';
import type { Attachment } from '../../core/schemas/attachment.js';
import type { StructuredSummary } from '../../core/schemas/compaction.js';
import type {
  Planner,
  PlannerCallbacks,
  PlannerOutputCallbacks,
  PlannerCapabilities,
  PriorMessage,
  PlannerSummaryMessage,
  PlannerStructuredSummaryOptions,
  PlannerSummaryOptions,
  PlannerUserTurnOptions,
  PlannerUserTurnResult,
} from './types.js';
import { DEFAULT_AVAILABILITY } from '../availability.js';
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
    'onOutput' | 'onSessionId' | 'onSessionExpired' | 'onCallEvent'
  >;
  priorMessages?: PriorMessage[] | undefined;
  images?: Attachment[] | undefined;
  schema?: TypedSchemaInput | undefined;
  signal?: AbortSignal | undefined;
};

type InternalPlanInvokeFn = (opts: InternalInvokeOptions) => Promise<RunnerCallResult>;
// invokeOneShot exists separately: Claude Code chains a session for planning turns but calls once for reviews and summaries.
type InternalOneShotInvokeFn = (opts: InternalInvokeOptions) => Promise<RunnerCallResult>;

export interface PlannerBaseConfig {
  invokePlan: InternalPlanInvokeFn;
  invokeOneShot: InternalOneShotInvokeFn;
  backendKind?: RunnerCallContext['backendKind'];
  runnerName?: string | undefined;
  model?: string | undefined;
  axes?: readonly string[] | undefined;
  isAvailable: () => Promise<boolean>;
  unavailabilityReason?: () => string | undefined;
  getVersion?: () => Promise<string | null>;
  capabilities: PlannerCapabilities;
  /** How a typed call reaches this backend; defaults to 'fallback'. */
  typedOutput?: TypedOutputCapability | undefined;
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
  const maxInputChars =
    config.runnerName !== undefined && isCliToolId(config.runnerName)
      ? CLI_TOOL_CATALOG[config.runnerName].maxInputChars
      : undefined;

  const planner: Planner = {
    async review(
      prompt: string,
      projectDir: string,
      callbacks: PlannerOutputCallbacks,
    ): Promise<{ text: string; usage: TokenDelta | null }> {
      const callContext = createPlannerCallContext(config, 'review');
      const result = requireCompletedCall(
        await config.invokeOneShot({
          prompt,
          projectDir,
          callContext,
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
      ...(maxInputChars !== undefined && { maxInputChars }),
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
        return config.invokeOneShot({
          prompt,
          projectDir: ctx.projectDir,
          callContext,
          callbacks: ctx.callbacks,
          signal: ctx.callbacks.signal,
          ...(ctx.images !== undefined && { images: ctx.images }),
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
