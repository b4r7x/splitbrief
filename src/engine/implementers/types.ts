import type { Task, Config, ProjectContext, TuiEvent, ImplementerResult, RunnerRuntime } from '../../types.js';

export interface ImplementerOptions {
  task: Task;
  projectDir: string;
  config: Config;
  context: ProjectContext;
  onOutput: (text: string) => void;
  onEvent?: (event: TuiEvent) => void;
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
