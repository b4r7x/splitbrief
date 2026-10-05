import type { Task } from '../../../core/schemas/task.js';
import type { Config } from '../../../core/schemas/config.js';
import type { EventBus, ValidationStageCommands } from '../../events/types.js';
import type { Phase, ValidationStage } from '../../../core/schemas/enums.js';
import type {
  DiscoveredValidation,
  PersistedValidationBaseline,
} from '../../../core/schemas/workflow.js';
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
  persistedBaseline?: PersistedValidationBaseline | undefined;
};

export type ValidationBaseline = {
  failingStages: ReadonlySet<ValidationStage>;
  commands: ValidationStageCommands;
  failures: Partial<Record<ValidationStage, ReadonlySet<string>>>;
};

export type FullSuiteFailureKeys = Partial<Record<ValidationStage, string[]>>;

export type RunFullSuiteOptions = {
  projectDir: string;
  config: Config;
  bus: EventBus;
  phase: Phase;
  discoveredValidation?: DiscoveredValidation | undefined;
  signal?: AbortSignal | undefined;
  baseline?: FullSuiteFailureKeys | undefined;
};

export type RunFullSuiteResult = {
  results: ValidationResult[];
  failures: FullSuiteFailureKeys;
  newFailures: FullSuiteFailureKeys;
};

export interface Validator {
  primeBaseline: (opts: PrimeBaselineOptions) => Promise<PersistedValidationBaseline | undefined>;
  runFullSuite: (opts: RunFullSuiteOptions) => Promise<RunFullSuiteResult>;
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
