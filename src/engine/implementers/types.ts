import type { ProjectContext } from '../../core/types/state-actions.js';
import type { Task } from '../../core/schemas/task.js';
import type { Config } from '../../core/schemas/config.js';
import type { TuiEvent } from '../../features/workflow/types.js';
import type { ImplementerResult } from '../../core/types/summary.js';
import type { RunnerRuntime } from '../runners/types.js';

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
