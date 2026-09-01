import type { collectReadiness } from '../../../core/readiness/collect.js';
import type { ReadinessCheck } from '../../../core/readiness/types.js';
import type { Config } from '../../../core/schemas/config.js';
import type { reactivateExistingSession } from '../../../core/sessions/active-pointer.js';
import type { prepareNewSession } from '../../../core/sessions/prepare.js';
import type { detectRunnerEvidence } from '../../detection/runner-evidence.js';
import type { collectArgVectorPreflightChecks } from '../arg-vector-preflight.js';
import type { prepareCustomRunnerAdmission } from '../custom-admission.js';
import type { RunnerGate } from '../prepared-execution.js';
import type { probeRunnerAvailability } from '../probe-availability.js';
import type { resolveCliExecutableAliases } from '../resolve-cli-executable.js';
import type { CustomRunnerAdmissionPolicy } from '../types.js';

type CommonPreparationPolicy = CustomRunnerAdmissionPolicy &
  Readonly<{
    unverifiedAuth: 'denied' | 'disclosed' | 'allowed';
    allowHooks: boolean;
  }>;

export type PreparationPolicy =
  | (CommonPreparationPolicy & Readonly<{ purpose: 'new-workflow' | 'spec' }>)
  | (CommonPreparationPolicy & Readonly<{ purpose: 'resume' }>);

export type PrepareExecutionDependencies = Readonly<{
  collectReadiness: typeof collectReadiness;
  collectArgVectorPreflightChecks: typeof collectArgVectorPreflightChecks;
  probeRunnerAvailability: typeof probeRunnerAvailability;
  detectRunnerEvidence: typeof detectRunnerEvidence;
  prepareCustomRunnerAdmission: typeof prepareCustomRunnerAdmission;
  resolveCliExecutableAliases: typeof resolveCliExecutableAliases;
  prepareNewSession: typeof prepareNewSession;
  reactivateExistingSession: typeof reactivateExistingSession;
  newPreparationId: () => string;
}>;

export type PreparationContext = Readonly<{
  projectDir: string;
  config: Config;
  policy: PreparationPolicy;
  preparationId: string;
  signal: AbortSignal;
  nativeTrustViolations: ReadonlySet<string>;
  deps: PrepareExecutionDependencies;
}>;

export type SlotEvaluation =
  | Readonly<{
      kind: 'admitted';
      check: ReadinessCheck;
      gate: RunnerGate;
      trustPersisted?: boolean | undefined;
    }>
  | Readonly<{ kind: 'blocked'; check: ReadinessCheck }>;
