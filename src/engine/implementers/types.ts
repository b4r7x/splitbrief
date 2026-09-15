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

export interface ImplementerResult {
  success: boolean;
  output: string;
  error?: string | undefined;
  /** Machine outcome behind a failure; the message is for humans, this is not. */
  outcome?: RunnerFailureOutcomeState | undefined;
  usage?: TokenDelta | undefined;
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
   * orchestrator's approval path. Defaults to `reject`.
   */
  undeclaredWrites?: 'reject' | 'gate' | undefined;
}

export interface ImplementerFactoryOptions {
  publisher?: ImplementerPublisher | undefined;
  allowRepoRunners?: boolean | undefined;
  /** Canonical CLI identity admitted by the start-readiness gate. */
  trustedCli?: CliStartGate | undefined;
  customRuntime?: CustomRunnerRuntimePort | undefined;
  slot?: Extract<RunnerSlot, { role: 'implementer' | 'intermediate' }> | undefined;
}

export interface ImplementerOptions extends UndeclaredWritesPolicy {
  task: Task;
  projectDir: string;
  config: Config;
  context: ProjectContext;
  onOutput: (text: string) => void;
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
  phase?: Phase | undefined;
  approveWrite?:
    | ((file: string) => Promise<{ allow: boolean; reason?: string | undefined }>)
    | undefined;
}

export interface RetryOptions extends ImplementerOptions {
  error: string;
  attempt: number;
  kind: 'local' | 'hint';
}

export interface InvokeOpts extends UndeclaredWritesPolicy {
  callContext: RunnerCallContext;
  prompt: string;
  task: Task;
  projectDir: string;
  config: Config;
  onOutput: (text: string) => void;
  systemPreamble: string;
  temperature?: number;
  signal?: AbortSignal | undefined;
  onCallEvent?: ((event: RunnerCallEvent) => void) | undefined;
  sandboxEnv?: NodeJS.ProcessEnv | undefined;
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
