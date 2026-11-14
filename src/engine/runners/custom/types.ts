import type { Phase } from '../../../core/schemas/enums.js';
import type { TaskId } from '../../../core/schemas/task.js';
import type { CustomRunnerAdmissionPolicy } from '../types.js';
import type { CustomRunnerAdmission } from './launchability.js';
import type { ConfiguredCustomRunner, CustomRunnerSecurityPosture } from './posture.js';

export type PreparedCustomRunnerAdmission =
  | Exclude<CustomRunnerAdmission, { kind: 'admitted' }>
  | (Extract<CustomRunnerAdmission, { kind: 'admitted' }> & Readonly<{ trustPersisted: boolean }>);

export interface PrepareCustomRunnerAdmissionOptions extends CustomRunnerAdmissionPolicy {
  readonly projectDir: string;
  readonly runner: ConfiguredCustomRunner;
  readonly posture: CustomRunnerSecurityPosture;
  readonly phase: Phase;
  readonly taskId?: TaskId | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly _beforeTrustWrite?: (() => void) | undefined;
  readonly _afterTrustWrite?: (() => void) | undefined;
  /** Executable-resolution authority, deliberately distinct from declared child environment. */
  readonly authorizationPathEnv?: string | undefined;
  /** Windows executable-extension authority, deliberately distinct from declared child environment. */
  readonly authorizationPathExt?: string | undefined;
}
