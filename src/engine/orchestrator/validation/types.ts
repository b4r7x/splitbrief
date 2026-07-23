import type { Task } from '../../../core/schemas/task.js';
import type { Config } from '../../../core/schemas/config.js';
import type { EventBus } from '../../events/types.js';
import type { Phase, ValidationStage } from '../../../core/schemas/enums.js';
import type { DiscoveredValidation } from '../../../core/schemas/workflow.js';
import type { runCommand } from '../../../lib/process/spawn/run-command.js';
import type { ValidationResult } from './result.js';

export type ValidationCommandRunner = typeof runCommand;

export type RunValidationOptions = {
  task: Task;
  projectDir: string;
  config: Config;
  bus: EventBus;
  phase: Phase;
  discoveredValidation?: DiscoveredValidation | undefined;
  signal?: AbortSignal | undefined;
};

export type PrimeBaselineOptions = {
  task: Task;
  projectDir: string;
  config: Config;
  discoveredValidation?: DiscoveredValidation | undefined;
  signal?: AbortSignal | undefined;
};

export interface Validator {
  primeBaseline: (opts: PrimeBaselineOptions) => Promise<void>;
  runValidation: (opts: RunValidationOptions) => Promise<ValidationResult[]>;
  getBaselineFailingStages?: (() => ReadonlySet<ValidationStage>) | undefined;
}

export type ValidatorDeps = {
  runCommand?: ValidationCommandRunner | undefined;
  captureBaseline?: boolean | undefined;
};
