import type { Task } from '../../../core/schemas/task.js';
import type { Config } from '../../../core/schemas/config.js';
import type { EventBus } from '../../events/types.js';
import type { Phase, ValidationStage } from '../../../core/schemas/enums.js';
import type { DiscoveredValidation, FullSuiteStageRuns } from '../../../core/schemas/workflow.js';
import type { runCommand } from '../../../lib/process/spawn/run-command.js';
import type { ValidationResult } from './result.js';
import type { TestTargetMode } from './commands.js';

export type ValidationCommandRunner = typeof runCommand;

export type RunValidationOptions = {
  task: Task;
  projectDir: string;
  config: Config;
  bus: EventBus;
  phase: Phase;
  discoveredValidation?: DiscoveredValidation | undefined;
  stages: readonly ValidationStage[];
  changedFiles: readonly string[];
  baseline?: FullSuiteFailureKeys | undefined;
  /** `check` runs the test stage unnarrowed when it cannot select related tests. */
  testMode?: TestTargetMode | undefined;
  signal?: AbortSignal | undefined;
};

export type FullSuiteFailureKeys = Partial<Record<ValidationStage, string[]>>;

export type FullSuiteMoment = 'baseline' | 'pre-review';

export type RunFullSuiteOptions = {
  projectDir: string;
  config: Config;
  bus: EventBus;
  phase: Phase;
  moment: FullSuiteMoment;
  discoveredValidation?: DiscoveredValidation | undefined;
  signal?: AbortSignal | undefined;
  baseline?: FullSuiteFailureKeys | undefined;
  baselineStages?: FullSuiteStageRuns | undefined;
};

export type RunFullSuiteResult = {
  results: ValidationResult[];
  failures: FullSuiteFailureKeys;
  newFailures: FullSuiteFailureKeys;
  stages: FullSuiteStageRuns;
};

export interface Validator {
  runFullSuite: (opts: RunFullSuiteOptions) => Promise<RunFullSuiteResult>;
  runValidation: (opts: RunValidationOptions) => Promise<ValidationResult[]>;
  formatChangedFiles: (opts: Omit<RunValidationOptions, 'stages' | 'baseline'>) => Promise<void>;
}

export type ValidatorDeps = {
  runCommand?: ValidationCommandRunner | undefined;
};
