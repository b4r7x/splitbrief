import type { collectReadiness } from '../../../core/readiness/collect.js';
import type { ReadinessCheck } from '../../../core/readiness/types.js';
import type { Config } from '../../../core/schemas/config.js';
import type { reactivateExistingSession } from '../../../core/sessions/active-pointer.js';
import type { prepareNewSession } from '../../../core/sessions/prepare.js';
import type { RouteCatalogReads } from '../../detection/route-catalog.js';
import type { detectRunnerEvidence } from '../../detection/runner-evidence.js';
import type { collectArgVectorPreflightChecks } from '../arg-vector-preflight.js';
import type { prepareCustomRunnerAdmission } from '../custom-admission.js';
import type { RunnerGate } from '../prepared-execution.js';
import type { probeRunnerAvailability } from '../probe-availability.js';
import type { resolveCliExecutableAliases } from '../resolve-cli-executable.js';
import type { CustomRunnerAdmissionPolicy } from '../types.js';
import type { ModelCacheAccessor } from '../../providers/model/resolution.js';

type CommonPreparationPolicy = CustomRunnerAdmissionPolicy &
  Readonly<{
    unverifiedAuth: 'denied' | 'disclosed' | 'allowed';
    allowHooks: boolean;
    /** The host's model catalog: the readiness report names each seat by its catalog label. */
    modelCache?: ModelCacheAccessor | undefined;
  }>;

export type PreparationPolicy =
  | (CommonPreparationPolicy & Readonly<{ purpose: 'new-workflow' | 'spec' }>)
  | (CommonPreparationPolicy & Readonly<{ purpose: 'review' }>)
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
  routeCatalogs: RouteCatalogReads;
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
