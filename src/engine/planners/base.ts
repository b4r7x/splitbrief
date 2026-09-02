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
  PlannerInvokeResult,
} from './types.js';
import type { TaskDispatchLedger } from '../calls/dispatch-ledger.js';
import type {
  TaskCompilationAttemptId,
  TaskCompilationCallEnvelope,
  PlannerSessionScope,
} from '../../core/schemas/task-compilation.js';
import type { CompilerCapabilityReceipt } from '../runners/compiler-capability.js';
import type { PreparedPlannerInvocation } from '../runners/types.js';
import { error } from '../../utils/error.js';
import { TASKS_FILE } from '../../core/paths.js';
import { buildQuickPlanPrompt } from '../spec/prompts/quick-plan.js';
import { DEFAULT_AVAILABILITY } from '../availability.js';
import { escalateFull, escalateHint } from './escalation.js';
import { runSinglePhasePlanning } from './single-phase.js';
import { runMultiPhasePlanning } from './multi-phase.js';
import { createPlannerCallContext } from './call-context.js';
import { summarize, summarizeStructured } from './summary.js';
import { toTokenDelta } from '../calls/projection.js';
import type { RunnerCallContext, RunnerCallResult } from '../calls/types.js';
import { requireCompletedCall } from './require-completed-call.js';

type InternalInvokeOptions = {
  prompt: string;
  projectDir: string;
  callContext: RunnerCallContext;
  callbacks: Pick<
    PlannerCallbacks,
    'onOutput' | 'onQuestion' | 'onSessionId' | 'onSessionExpired' | 'sessionId' | 'onCallEvent'
  >;
  priorMessages?: PriorMessage[] | undefined;
  images?: Attachment[] | undefined;
  signal?: AbortSignal | undefined;
  sandboxEnv?: NodeJS.ProcessEnv | undefined;
};

// artifactFile names the artifact the phase reads back (e.g. tasks.md), so a backend that writes
// it directly is not mistaken for a planner mutating the project.
type InternalPlanInvokeFn = (
  opts: InternalInvokeOptions & { artifactFile?: string | undefined },
) => Promise<PlannerInvokeResult>;
// invokeEscalate exists separately: Claude Code uses session-chaining for plan phases but one-shot for escalations.
type InternalEscalateInvokeFn = (
  opts: InternalInvokeOptions & { accessMode: 'read-only' | 'write-files' },
) => Promise<RunnerCallResult>;

export type CompilerBatchDispatch = (
  input: Readonly<{
    attemptId: TaskCompilationAttemptId;
    batch: Readonly<{
      batchId: string;
      prompt: string;
      envelope: TaskCompilationCallEnvelope;
    }>;
    sessionScope: PlannerSessionScope;
    projectDir: string;
  }>,
) => Promise<PlannerInvokeResult>;

/**
 * The deterministic Task compiler seam (REQ-016, REQ-046). Standard/speckit
 * planning and Brief recovery share one operation-wide ledger, so planning
 * batches and repair/retry batches claim against the same 64-dispatch ceiling
 * and the same `PreparedPlannerInvocation` carries the call evidence.
 */
export type CompilerSeam = Readonly<{
  invocation: PreparedPlannerInvocation;
  ledger: TaskDispatchLedger;
  dispatch: CompilerBatchDispatch;
  receipt?: CompilerCapabilityReceipt | undefined;
}>;

export type CompilerRefusal = Readonly<{
  code: 'task_compiler_capability_unsupported';
  message: string;
}>;

/**
 * One planner carries one compiler attachment: the admitted seam or the typed
 * refusal, never both. The two installers write the same record, so the later
 * install replaces the earlier one instead of leaving a refused planner holding
 * a live seam.
 */
type CompilerAttachment =
  | Readonly<{ kind: 'seam'; seam: CompilerSeam }>
  | Readonly<{ kind: 'refusal'; refusal: CompilerRefusal }>;

const compilerAttachments = new WeakMap<Planner, CompilerAttachment>();
const compilerDispatches = new WeakMap<Planner, CompilerBatchDispatch>();

export function installCompilerSeam(planner: Planner, seam: CompilerSeam): void {
  compilerAttachments.set(planner, { kind: 'seam', seam });
}

export function installCompilerRefusal(planner: Planner, refusal: CompilerRefusal): void {
  compilerAttachments.set(planner, { kind: 'refusal', refusal });
}

export function readPlannerCompilerSeam(planner: Planner): CompilerSeam | null {
  const attachment = compilerAttachments.get(planner);
  return attachment?.kind === 'seam' ? attachment.seam : null;
}

export function readPlannerCompilerRefusal(planner: Planner): CompilerRefusal | null {
  const attachment = compilerAttachments.get(planner);
  return attachment?.kind === 'refusal' ? attachment.refusal : null;
}

export function readPlannerCompilerDispatch(planner: Planner): CompilerBatchDispatch | null {
  return compilerDispatches.get(planner) ?? null;
}

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
  injectUserTurn?: (opts: PlannerUserTurnOptions) => Promise<TokenDelta | null>;
}
export function createPlannerBase(config: PlannerBaseConfig): Planner {
  const capabilities = config.capabilities;

  const planner: Planner = {
    async plan(opts: PlanOptions): Promise<PlanResult> {
      const refusal = readPlannerCompilerRefusal(planner);
      if (refusal !== null) {
        throw error(refusal.code, refusal.message, {
          backend: config.runnerName ?? config.backendKind ?? 'unknown',
          missing: ['conformance'],
        });
      }
      const seam = readPlannerCompilerSeam(planner);
      return runMultiPhasePlanning({ ...config, ...(seam !== null && { compiler: seam }) }, opts);
    },
    async quickPlan(opts: PlanOptions): Promise<PlanResult> {
      return runSinglePhasePlanning(
        config,
        (feature, projectContext, languageContext) =>
          buildQuickPlanPrompt({ feature, projectContext, languageContext, trivial: opts.trivial }),
        opts,
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
          accessMode: 'read-only',
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
          accessMode: 'read-only',
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

  const dispatch: CompilerBatchDispatch = async (input) => {
    const seam = readPlannerCompilerSeam(planner);
    if (seam === null) {
      throw error(
        'task_compiler_capability_unsupported',
        'The planner has no compiler seam installed.',
      );
    }
    return config.invokePlan({
      prompt: input.batch.prompt,
      projectDir: input.projectDir,
      callContext: {
        ...createPlannerCallContext(
          {
            transport: seam.invocation.transport,
            sessionScope: input.sessionScope,
            envelope: input.batch.envelope,
            ...(config.backendKind !== undefined && { backendKind: config.backendKind }),
            ...(config.runnerName !== undefined && { runnerName: config.runnerName }),
            ...(config.model !== undefined && { model: config.model }),
          },
          'planner',
        ),
        callId: input.attemptId,
        attemptId: input.attemptId,
      },
      callbacks: { onOutput: () => {} },
      artifactFile: TASKS_FILE,
    });
  };

  compilerDispatches.set(planner, dispatch);

  return planner;
}
