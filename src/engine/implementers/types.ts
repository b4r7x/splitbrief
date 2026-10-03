import type { ChangeDetectionKind } from '../change-detection.js';
import type { ProjectContext } from '../../core/state/types.js';
import type { Task, TaskId } from '../../core/schemas/task.js';
import type { Config } from '../../core/schemas/config.js';
import type { TokenDelta } from '../../core/schemas/tokens.js';
import type { LanguageContext } from '../spec/prompts/language-context.js';
import type { CustomRunnerRuntimePort, RunnerRuntime } from '../runners/types.js';
import type { RunnerFailureOutcomeState } from '../runners/errors.js';
import type { RunnerCallContext, RunnerCallEvent } from '../calls/types.js';
import type { CliStartGate } from '../runners/start-gate.js';
import type { Phase } from '../../core/schemas/enums.js';
import type * as ImplementerConfig from '../../core/schemas/implementer-config.js';
import type { RunnerSlot } from '../runners/prepared-execution.js';
import type { BundleApplyResult } from './file-bundle.js';
import type { ImplementerReport } from '../../core/schemas/consult.js';
import type { PlanContext } from '../spec/prompt-formatter.js';

export interface ImplementerResult {
  success: boolean;
  output: string;
  error?: string | undefined;
  /** Machine outcome behind a failure; the message is for humans, this is not. */
  outcome?: RunnerFailureOutcomeState | undefined;
  usage?: TokenDelta | undefined;
  /** What a `file-bundle-v1` response actually did on disk; absent for every other grammar. */
  applyResult?: BundleApplyResult | undefined;
  /** The direct writer's closing report, when its reply ended with a valid one. */
  report?: ImplementerReport | undefined;
  /** The files or the decision the attempt asked for instead of finishing. */
  blocked?: { question: string; filesNeeded: string[] } | undefined;
}

export interface ImplementerPublisher {
  publishRunning(opts: { phase: Phase; taskId: TaskId; file?: string | undefined }): void;
  publishCallEvent(opts: { phase: Phase; taskId: TaskId; event: RunnerCallEvent }): void;
  publishDone(opts: {
    phase: Phase;
    taskId: TaskId;
    file: string;
    diff?: string | undefined;
    linesAdded: number;
    linesRemoved: number;
    duration: number;
    noChange?: boolean | undefined;
  }): void;
  publishFailed(opts: { phase: Phase; taskId: TaskId; model?: string | undefined }): void;
  publishWarning(opts: {
    phase: Phase;
    taskId: TaskId;
    message: string;
    safety: { category: string; code: string };
  }): void;
}

export interface UndeclaredWritesPolicy {
  /**
   * What a completed direct-write attempt does with files outside the brief's
   * declared set: `reject` fails the attempt, `gate` leaves the verdict to the
   * orchestrator's approval path. Defaults to `gate`.
   */
  undeclaredWrites?: 'reject' | 'gate' | undefined;
}

export interface ImplementerFactoryOptions {
  publisher?: ImplementerPublisher | undefined;
  allowRepoRunners?: boolean | undefined;
  /** Canonical CLI identity admitted by the start-readiness gate. */
  trustedCli?: CliStartGate | undefined;
  customRuntime?: CustomRunnerRuntimePort | undefined;
  slot?: Extract<RunnerSlot, { role: 'implementer' }> | undefined;
}

export interface ImplementerOptions extends UndeclaredWritesPolicy {
  task: Task;
  projectDir: string;
  config: Config;
  context: ProjectContext;
  onOutput: (text: string, opts?: { messageStart?: boolean | undefined }) => void;
  sessionId?: string | undefined;
  signal?: AbortSignal | undefined;
  sandboxEnv?: NodeJS.ProcessEnv | undefined;
  fileIgnoreProjectDir?: string | undefined;
  /** Baseline the caller's workspace declares; sniffed from the directory when absent. */
  changeDetection?: ChangeDetectionKind | undefined;
  /**
   * The brief restarts on its own prompt; this is what the cut attempt left
   * behind. `extra` carries the declared files that already changed, so the
   * implementer edits on top of them instead of rewriting from scratch.
   */
  continuation?:
    | { partial?: string | undefined; steer?: string | undefined; extra?: string | undefined }
    | undefined;
  languageContext?: LanguageContext | undefined;
  plan?: PlanContext | undefined;
  phase?: Phase | undefined;
  /**
   * Paths an earlier attempt of this same task is recorded to have created. A
   * retry rewrites them instead of refusing to create them twice; what this
   * seat created in its own process counts alongside them.
   */
  createdByThisTask?: readonly string[] | undefined;
  approveWrite?:
    | ((file: string) => Promise<{ allow: boolean; reason?: string | undefined }>)
    | undefined;
  /**
   * A brief reopened by the final review already has its code on disk, so a
   * direct-write attempt that verifies and changes nothing completes instead of
   * failing `no-staged-change`. Every other attempt must change something.
   */
  allowNoChange?: boolean | undefined;
}

export interface RetryOptions extends ImplementerOptions {
  error: string;
  attempt: number;
  kind: 'local' | 'consult';
}

export interface InvokeOpts extends UndeclaredWritesPolicy {
  callContext: RunnerCallContext;
  prompt: string;
  task: Task;
  projectDir: string;
  config: Config;
  onOutput: (text: string, opts?: { messageStart?: boolean | undefined }) => void;
  systemPreamble: string;
  temperature?: number;
  signal?: AbortSignal | undefined;
  onCallEvent?: ((event: RunnerCallEvent) => void) | undefined;
  sandboxEnv?: NodeJS.ProcessEnv | undefined;
  /**
   * The checkout the run promotes into, when this call works in an isolation
   * directory of its own. The call's tool uses may not reach it.
   */
  checkoutDir?: string | undefined;
  /** The run's global skills, which the call's tool uses may read and never write. */
  skillRoots?: readonly string[] | undefined;
  /** Carries `ImplementerOptions.allowNoChange` to the call's declared-effect gate. */
  allowNoChange?: boolean | undefined;
}

export interface Implementer extends RunnerRuntime {
  implement(opts: ImplementerOptions): Promise<ImplementerResult>;
  retry(opts: RetryOptions): Promise<ImplementerResult>;
  capabilities?: ImplementerConfig.ImplementerCapabilities | undefined;

  /**
   * Human-readable cause for the most recent `isAvailable()` returning false
   * (e.g. missing API key, unreachable endpoint, auth rejection, empty model list).
   * Backends that can only fail to install do not implement it.
   */
  unavailabilityReason?: () => string | undefined;
}
