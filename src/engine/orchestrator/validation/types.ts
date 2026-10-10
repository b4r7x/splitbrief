import type { Task } from '../../../core/schemas/task.js';
import type { Config } from '../../../core/schemas/config.js';
import type { EventBus } from '../../events/types.js';
import type { Phase } from '../../../core/schemas/enums.js';
import type { runCommand } from '../../../lib/process/spawn/run-command.js';

export type ValidationCommandRunner = typeof runCommand;

export type FormatChangedFilesOptions = {
  task: Task;
  projectDir: string;
  config: Config;
  bus: EventBus;
  phase: Phase;
  changedFiles: readonly string[];
  signal?: AbortSignal | undefined;
};

export interface Validator {
  formatChangedFiles: (opts: FormatChangedFilesOptions) => Promise<void>;
}

export type ValidatorDeps = {
  runCommand?: ValidationCommandRunner | undefined;
};
