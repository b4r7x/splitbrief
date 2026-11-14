import type { Config } from '../../../../core/schemas/config.js';
import type { Phase } from '../../../../core/schemas/enums.js';
import type { Plan } from '../../../../core/schemas/plan.js';
import type { CheckStatus, Task, Check } from '../../../../core/schemas/task.js';
import type { DiscoveredValidation } from '../../../../core/schemas/workflow/state.js';
import type { EventBus } from '../../../events/types.js';
import type { RunBase } from '../../isolation/run-base/tree.js';
import type { FailureKeys } from '../extract-failure-keys.js';
import type { CheckResultStore } from '../result-store.js';
import type { planTestCheck } from '../run.js';
import type { ValidationCommandRunner } from '../types.js';

export type CheckRunArtifact = {
  path: string;
  sha256: string;
};

export type CheckRunResult = {
  checkId: string;
  output: string;
  command?: string | undefined;
  exitCode?: number | undefined;
  timedOut?: true | undefined;
  artifacts?: CheckRunArtifact[] | undefined;
  /** The failure keys the same command also showed at the run base. */
  preExisting?: readonly string[] | undefined;
  /** The same command's re-run at the run base. */
  base?: { output: string; exitCode?: number | undefined } | undefined;
  /** Not runnable because a program is missing (`notRunnableReason`): installing it is the fix. */
  missingProgram?: true | undefined;
  /** The time the stored run of the same command on the same tree state ran: nothing ran now. */
  reusedAt?: string | undefined;
} & (
  | {
      status: 'fail';
      /** The failure keys of the red, read from its whole capture; `output` keeps only its tail. */
      failure: FailureKeys;
    }
  | { status: Exclude<CheckStatus, 'fail'> }
);

export type RunChecksOptions = {
  task?: Task | undefined;
  tasks?: readonly Task[] | undefined;
  plan?: Plan | undefined;
  /** The project gate as `cmd` checks; a script the run changed refuses its check. */
  reviewChecks?: readonly Check[] | undefined;
  /** The run base: a reviewer check whose script this run changed is refused against it. */
  base?: RunBase | undefined;
  projectDir: string;
  sessionId?: string | undefined;
  checkoutDir?: string | undefined;
  config: Config;
  bus: EventBus;
  phase: Phase;
  npmScriptsApproved: boolean;
  discoveredValidation?: DiscoveredValidation | undefined;
  signal?: AbortSignal | undefined;
  runCommand?: ValidationCommandRunner | undefined;
  /**
   * Per `cmd` check id, the test files it runs alone when its command is the stack's test command
   * and the stack can select them; the next review runs the whole command.
   */
  testFiles?: ReadonlyMap<string, readonly string[]> | undefined;
  /** The run's stored command results; without it every command runs. */
  results?: CheckResultStore | undefined;
};

export type TestCheckPlan = ReturnType<typeof planTestCheck>;
