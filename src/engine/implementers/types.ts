import type { Task, ProjectContext } from '../../core/types/state-actions.js';
import type { Config } from '../../core/types/config-options.js';
import type { TuiEvent } from '../../core/types/events.js';
import type { ImplementerResult } from '../../core/types/summary.js';
import type { RunnerRuntime } from '../../core/types/runner.js';

export interface ImplementerOptions {
  task: Task;
  projectDir: string;
  config: Config;
  context: ProjectContext;
  onOutput: (text: string) => void;
  onEvent?: (event: TuiEvent) => void;
  sessionId?: string | undefined;
  signal?: AbortSignal | undefined;
  continuationPrompt?: string | undefined;
}

export interface RetryOptions extends ImplementerOptions {
  error: string;
  attempt: number;
  kind: 'local' | 'hint';
}

export interface Implementer extends RunnerRuntime {
  implement(opts: ImplementerOptions): Promise<ImplementerResult>;
  retry(opts: RetryOptions): Promise<ImplementerResult>;
}
