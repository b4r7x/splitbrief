import type { ProjectContext } from '../../core/types/state-actions.js';
import type { Task } from '../../core/schemas/task.js';
import type { Config } from '../../core/schemas/config.js';
import type { ImplementerResult } from '../../core/types/summary.js';
import type { RunnerRuntime } from '../runners/types.js';
import type { EventBus } from '../events/types.js';
import type { Phase } from '../../core/schemas/enums.js';

export type ImplementerWriteMode = 'extracted-code' | 'direct';

export type ImplementerCapabilities = {
  writesFiles: ImplementerWriteMode;
};

export interface ImplementerOptions {
  task: Task;
  projectDir: string;
  config: Config;
  context: ProjectContext;
  onOutput: (text: string) => void;
  sessionId?: string | undefined;
  signal?: AbortSignal | undefined;
  continuationPrompt?: string | undefined;
  bus?: EventBus | undefined;
  phase?: Phase | undefined;
  approveWrite?: ((file: string) => Promise<{ allow: boolean; reason?: string | undefined }>) | undefined;
}

export interface RetryOptions extends ImplementerOptions {
  error: string;
  attempt: number;
  kind: 'local' | 'hint';
}

export interface Implementer extends RunnerRuntime {
  implement(opts: ImplementerOptions): Promise<ImplementerResult>;
  retry(opts: RetryOptions): Promise<ImplementerResult>;
  capabilities?: ImplementerCapabilities | undefined;
}
