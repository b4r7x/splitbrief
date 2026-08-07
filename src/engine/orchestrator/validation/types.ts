import type { Task } from '../../../core/schemas/task.js';
import type { Config } from '../../../core/schemas/config.js';
import type { EventBus, ValidationStageCommands } from '../../events/types.js';
import type { Phase, ValidationStage } from '../../../core/schemas/enums.js';
import type { DiscoveredValidation } from '../../../core/schemas/workflow.js';
import type { runCommand } from '../../../lib/process/spawn/run-command.js';
import type { ValidationResult } from './result.js';
import type { ValidationAcceptance } from './acceptance.js';

export type ValidationCommandRunner = typeof runCommand;

export type RunValidationOptions = {
  task: Task;
  projectDir: string;
  config: Config;
  bus: EventBus;
  phase: Phase;
  discoveredValidation?: DiscoveredValidation | undefined;
  changedFiles?: readonly string[] | undefined;
  signal?: AbortSignal | undefined;
};

export type PrimeBaselineOptions = {
  task: Task;
  projectDir: string;
  config: Config;
  bus: EventBus;
  phase: Phase;
  discoveredValidation?: DiscoveredValidation | undefined;
  signal?: AbortSignal | undefined;
};

export type ValidationBaseline = {
  failingStages: ReadonlySet<ValidationStage>;
  commands: ValidationStageCommands;
};

export interface Validator {
  primeBaseline: (opts: PrimeBaselineOptions) => Promise<void>;
  runValidation: (opts: RunValidationOptions) => Promise<ValidationResult[]>;
  decideAcceptance: (opts: {
    results: readonly ValidationResult[];
    changedFiles: readonly string[];
  }) => ValidationAcceptance;
}

export type ValidatorDeps = {
  runCommand?: ValidationCommandRunner | undefined;
  captureBaseline?: boolean | undefined;
};
