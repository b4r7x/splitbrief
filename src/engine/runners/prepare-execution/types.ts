import type { collectReadiness } from '../../../core/readiness/collect.js';
import type { ReadinessCheck, ReadinessReport } from '../../../core/readiness/types.js';
import type { Config } from '../../../core/schemas/config.js';
import type { reactivateExistingSession } from '../../../core/sessions/active-pointer.js';
import type { prepareNewSession } from '../../../core/sessions/prepare.js';
import type { RouteCatalogReads } from '../../detection/route-catalog.js';
import type { VersionProbeReads } from '../cli-tools/probe/declared-readiness.js';
import type { detectRunnerEvidence } from '../../detection/runner-evidence/detect.js';
import type { collectArgVectorPreflightChecks } from '../arg-vector/preflight.js';
import type { prepareCustomRunnerAdmission } from '../custom/admission.js';
import type { PreparedConfig, RunnerGate } from './prepared.js';
import type { probeRunnerAvailability } from '../probe-availability.js';
import type { resolveCliExecutableAliases } from '../cli-executable/resolve.js';
import type { CustomRunnerAdmissionPolicy } from '../types.js';
import type { ModelCacheAccessor } from '../../providers/model/runtime-snapshot.js';
import type { RunnerCandidate } from './runner-candidates.js';
import type { EffectiveConfigWarning } from '../../../core/config/runtime/effective-config.js';
import type { SessionRef } from '../../../core/types/session-ref.js';
import type { CliSeatGates } from '../seat-gates.js';

type CommonPreparationPolicy = CustomRunnerAdmissionPolicy &
  Readonly<{
    unverifiedAuth: 'denied' | 'disclosed' | 'allowed';
    allowHooks: boolean;
    /** The host's model catalog: the readiness report names each seat by its catalog label. */
    modelCache?: ModelCacheAccessor | undefined;
    /** The window detected for the build seat; readiness shows it while the seat sets no Prompt budget. */
    getDetectedContextLength?: (() => number | undefined) | undefined;
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
  versionProbes: VersionProbeReads;
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

export type EvaluatedSlot = Readonly<{
  candidate: RunnerCandidate;
  evaluation: SlotEvaluation;
}>;

export type AdmissionInput = Readonly<{
  projectDir: string;
  effectiveConfig: Config;
  configWarnings: readonly EffectiveConfigWarning[];
  policy: PreparationPolicy;
  signal: AbortSignal;
  deps?: Partial<PrepareExecutionDependencies> | undefined;
  resumeSession?: SessionRef | undefined;
  reviewSettingsSeat?: 'planner' | 'reviewer' | undefined;
}>;

export type AdmittedRunners = Readonly<{
  config: PreparedConfig;
  sourceConfig: PreparedConfig;
  preparationId: string;
  report: ReadinessReport;
  gates: readonly RunnerGate[];
  cliSeats: CliSeatGates;
  deps: PrepareExecutionDependencies;
  trustPersisted: boolean;
}>;

export type AdmissionResult =
  | Readonly<{ kind: 'admitted'; admitted: AdmittedRunners }>
  | Readonly<{ kind: 'blocked'; report: ReadinessReport }>;

/** The last report the caller can attach to a failure, updated as it is refined. */
export type ReportSink = { report?: ReadinessReport | undefined };
