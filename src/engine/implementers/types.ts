import type { ProjectContext } from '../../core/state/types.js';
import type { Task, TaskId } from '../../core/schemas/task.js';
import type { Config } from '../../core/schemas/config.js';
import type { TokenDelta } from '../../core/schemas/tokens.js';
import type { LanguageContext } from '../spec/prompts/language-context.js';
import type { RunnerRuntime } from '../runners/types.js';
import type { RunnerCallContext } from '../calls/types.js';
import type { Phase } from '../../core/schemas/enums.js';
import type * as ImplementerConfig from '../../core/schemas/implementer-config.js';

export interface ImplementerResult {
  success: boolean;
  output: string;
  error?: string | undefined;
  usage?: TokenDelta | undefined;
}

export interface ImplementerPublisher {
  publishRunning(opts: { phase: Phase; taskId: TaskId; file?: string | undefined }): void;
  publishDone(opts: {
    phase: Phase;
    taskId: TaskId;
    file: string;
    diff?: string | undefined;
    linesAdded: number;
    linesRemoved: number;
    duration: number;
  }): void;
  publishFailed(opts: { phase: Phase; taskId: TaskId; model: string }): void;
}

export interface ImplementerFactoryOptions {
  publisher?: ImplementerPublisher | undefined;
}

export interface ImplementerOptions {
  task: Task;
  projectDir: string;
  config: Config;
  context: ProjectContext;
  onOutput: (text: string) => void;
  sessionId?: string | undefined;
  signal?: AbortSignal | undefined;
  sandboxEnv?: NodeJS.ProcessEnv | undefined;
  fileIgnoreProjectDir?: string | undefined;
  continuationPrompt?: string | undefined;
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

export interface InvokeOpts {
  callContext: RunnerCallContext;
  prompt: string;
  task: Task;
  projectDir: string;
  config: Config;
  onOutput: (text: string) => void;
  systemPreamble: string;
  temperature?: number;
  signal?: AbortSignal | undefined;
  sandboxEnv?: NodeJS.ProcessEnv | undefined;
}

export interface Implementer extends RunnerRuntime {
  implement(opts: ImplementerOptions): Promise<ImplementerResult>;
  retry(opts: RetryOptions): Promise<ImplementerResult>;
  capabilities?: ImplementerConfig.ImplementerCapabilities | undefined;
}
