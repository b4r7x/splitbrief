import type { Task, Config, ProjectContext, TuiEvent, ImplementerResult } from '../../types.js';

export interface ImplementerOptions {
  task: Task;
  projectDir: string;
  config: Config;
  context: ProjectContext;
  onProgress: (text: string) => void;
  onEvent?: (event: TuiEvent) => void;
}

export interface RetryOptions extends ImplementerOptions {
  error: string;
  attempt: number;
}

export interface Implementer {
  implement(opts: ImplementerOptions): Promise<ImplementerResult>;
  retry(opts: RetryOptions): Promise<ImplementerResult>;
}
