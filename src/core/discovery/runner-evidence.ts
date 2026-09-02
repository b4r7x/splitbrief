import type { DetectedModel, ExecutableIdentity } from './detection.js';
import { assertNever } from '../../utils/type-guards.js';

export type { ExecutableIdentity };

export const RUNNER_EVIDENCE_KINDS = ['cli', 'api', 'shell', 'agent'] as const;
export type RunnerEvidenceKind = (typeof RUNNER_EVIDENCE_KINDS)[number];

export const PROBE_OUTCOME_KINDS = [
  'success',
  'unsupported',
  'missing-credential',
  'invalid-credential',
  'policy-denied',
  'offline',
  'timeout',
  'malformed',
  'cancelled',
  'not-run',
] as const;
export type ProbeOutcomeKind = (typeof PROBE_OUTCOME_KINDS)[number];

export type ProbeOutcome<Value> = {
  [Kind in ProbeOutcomeKind]: Kind extends 'success'
    ? Readonly<{ kind: Kind; value: Value }>
    : Readonly<{ kind: Kind }>;
}[ProbeOutcomeKind];

export const MODEL_RUN_FACT_KINDS = [
  'unknown',
  'listed-unverified',
  'verified-by-last-run',
  'rejected',
] as const;
export type ModelRunFactKind = (typeof MODEL_RUN_FACT_KINDS)[number];

export type ModelRunFact = {
  [Kind in ModelRunFactKind]: Readonly<{
    kind: Kind;
    selectionId: string;
    observedAt: number;
    contextKey: string;
  }>;
}[ModelRunFactKind];

export type ExecutableFact =
  | Readonly<{ kind: 'not-applicable' }>
  | Readonly<{ kind: 'missing' }>
  | Readonly<{ kind: 'unknown' }>
  | Readonly<{ kind: 'untrusted' }>
  | Readonly<{ kind: 'identity-drifted' }>
  | Readonly<{ kind: 'trusted'; identity: ExecutableIdentity }>;

export type CompatibilityFact =
  | Readonly<{ kind: 'not-applicable' }>
  | Readonly<{ kind: 'compatible'; installedVersion: string; testedVersion: string }>
  | Readonly<{ kind: 'incompatible'; installedVersion: string; testedVersion: string }>
  | Readonly<{ kind: 'unknown'; installedVersion: string | null; testedVersion: string }>;

export const AUTH_FACT_KINDS = [
  'not-required',
  'not-selected',
  'verified',
  'unknown',
  'missing',
  'invalid',
  'policy-denied',
  'offline',
  'timeout',
  'malformed',
  'cancelled',
  'not-run',
] as const;
export type AuthFact = (typeof AUTH_FACT_KINDS)[number];

export type CredentialPresence = 'present' | 'absent' | 'unknown' | 'not-applicable';
export type RunnerInstallationFact = 'installed' | 'missing' | 'unknown' | 'not-applicable';
export type RunnerEvidenceSource = 'fresh' | 'cached';

export type RunnerEvidence = Readonly<{
  runner: Readonly<{
    id: string;
    kind: RunnerEvidenceKind;
    locality: 'local' | 'remote' | 'unknown';
    enabled: 'enabled' | 'disabled';
  }>;
  context: Readonly<{
    key: string;
    observedAt: number;
    source: RunnerEvidenceSource;
  }>;
  installation: RunnerInstallationFact;
  executable: ExecutableFact;
  compatibility: CompatibilityFact;
  credential: CredentialPresence;
  auth: AuthFact;
  endpoint: ProbeOutcome<null>;
  catalog: ProbeOutcome<readonly DetectedModel[]>;
  modelRun: ModelRunFact;
}>;

export type RunnerStatus =
  | Readonly<{ kind: 'disabled' }>
  | Readonly<{ kind: 'not-installed' }>
  | Readonly<{ kind: 'installation-unresolved' }>
  | Readonly<{ kind: 'executable-missing' }>
  | Readonly<{ kind: 'executable-unresolved' }>
  | Readonly<{ kind: 'executable-untrusted' }>
  | Readonly<{ kind: 'identity-drifted' }>
  | Readonly<{ kind: 'compatibility-incompatible' }>
  | Readonly<{ kind: 'authentication-missing' }>
  | Readonly<{ kind: 'authentication-invalid' }>
  | Readonly<{ kind: 'authentication-policy-denied' }>
  | Readonly<{ kind: 'installed-configurable'; reason: 'compatibility-unknown' | AuthFact }>
  | Readonly<{ kind: 'endpoint-unresolved'; outcome: Exclude<ProbeOutcomeKind, 'success'> }>
  | Readonly<{ kind: 'catalog-unresolved'; outcome: Exclude<ProbeOutcomeKind, 'success'> }>
  | Readonly<{ kind: 'catalog-empty' }>
  | Readonly<{ kind: 'model-rejected' }>
  | Readonly<{ kind: 'facts-complete' }>;

/**
 * Derives a presentation status only. It deliberately contains no start
 * authorization decision; `admitStart` requires fresh context-bound evidence.
 */
export function deriveRunnerStatus(evidence: RunnerEvidence): RunnerStatus {
  if (evidence.runner.enabled === 'disabled') return { kind: 'disabled' };
  if (evidence.installation === 'missing') return { kind: 'not-installed' };
  if (evidence.installation === 'unknown') return { kind: 'installation-unresolved' };
  if (evidence.executable.kind === 'missing') return { kind: 'executable-missing' };
  if (evidence.executable.kind === 'unknown') return { kind: 'executable-unresolved' };
  if (evidence.executable.kind === 'untrusted') return { kind: 'executable-untrusted' };
  if (evidence.executable.kind === 'identity-drifted') return { kind: 'identity-drifted' };
  if (evidence.compatibility.kind === 'incompatible') return { kind: 'compatibility-incompatible' };
  if (evidence.compatibility.kind === 'unknown') {
    return { kind: 'installed-configurable', reason: 'compatibility-unknown' };
  }

  switch (evidence.auth) {
    case 'missing':
      return { kind: 'authentication-missing' };
    case 'invalid':
      return { kind: 'authentication-invalid' };
    case 'policy-denied':
      return { kind: 'authentication-policy-denied' };
    case 'not-required':
    case 'verified':
      break;
    case 'not-selected':
    case 'unknown':
    case 'offline':
    case 'timeout':
    case 'malformed':
    case 'cancelled':
    case 'not-run':
      return { kind: 'installed-configurable', reason: evidence.auth };
    default:
      return assertNever(evidence.auth);
  }

  if (evidence.runner.kind === 'api' && evidence.endpoint.kind !== 'success') {
    return { kind: 'endpoint-unresolved', outcome: evidence.endpoint.kind };
  }
  if (evidence.runner.kind === 'api' && evidence.catalog.kind !== 'success') {
    return { kind: 'catalog-unresolved', outcome: evidence.catalog.kind };
  }
  if (
    evidence.runner.kind === 'api' &&
    evidence.catalog.kind === 'success' &&
    evidence.catalog.value.length === 0
  ) {
    return { kind: 'catalog-empty' };
  }
  if (evidence.modelRun.kind === 'rejected') return { kind: 'model-rejected' };
  return { kind: 'facts-complete' };
}

export const START_FACTS = [
  'trusted-executable',
  'compatible-version',
  'authentication',
  'reachable-endpoint',
  'catalog',
  'model-run',
] as const;
export type StartFact = (typeof START_FACTS)[number];

export type StartAdmissionOptions = Readonly<{
  evidence: RunnerEvidence;
  expectedContextKey: string;
  expectedSelectionId: string;
  requiredFacts: readonly StartFact[];
  interaction: 'interactive' | 'headless';
  unverifiedAuth: 'denied' | 'disclosed' | 'allowed';
}>;

export type StartAdmission =
  | Readonly<{ kind: 'admitted' }>
  | Readonly<{ kind: 'disclosure-required'; auth: 'unknown' }>
  | Readonly<{
      kind: 'denied';
      reason:
        | Readonly<{ kind: 'evidence-source'; source: Exclude<RunnerEvidenceSource, 'fresh'> }>
        | Readonly<{ kind: 'context-mismatch' }>
        | Readonly<{ kind: 'disabled' }>
        | Readonly<{ kind: 'installation'; fact: Exclude<RunnerInstallationFact, 'installed'> }>
        | Readonly<{
            kind: 'executable';
            fact: Exclude<ExecutableFact['kind'], 'trusted' | 'not-applicable'>;
          }>
        | Readonly<{
            kind: 'compatibility';
            fact: Exclude<CompatibilityFact['kind'], 'compatible' | 'not-applicable'>;
          }>
        | Readonly<{
            kind: 'authentication';
            fact: Exclude<AuthFact, 'verified' | 'not-required' | 'unknown'>;
          }>
        | Readonly<{ kind: 'authentication-unverified' }>
        | Readonly<{
            kind: 'probe';
            fact: 'reachable-endpoint' | 'catalog';
            outcome: Exclude<ProbeOutcomeKind, 'success'>;
          }>
        | Readonly<{ kind: 'model-run'; fact: Exclude<ModelRunFactKind, 'verified-by-last-run'> }>
        | Readonly<{ kind: 'model-context-mismatch' }>;
    }>;

/**
 * Applies the start-only policy to evidence gathered for this exact run.
 * Cached evidence is always denied before any other fact is considered.
 */
export function admitStart(options: StartAdmissionOptions): StartAdmission {
  const { evidence } = options;
  if (evidence.context.source !== 'fresh') {
    return { kind: 'denied', reason: { kind: 'evidence-source', source: evidence.context.source } };
  }
  if (evidence.context.key !== options.expectedContextKey) {
    return { kind: 'denied', reason: { kind: 'context-mismatch' } };
  }
  if (evidence.runner.enabled === 'disabled')
    return { kind: 'denied', reason: { kind: 'disabled' } };
  if (evidence.installation !== 'installed' && evidence.installation !== 'not-applicable') {
    return { kind: 'denied', reason: { kind: 'installation', fact: evidence.installation } };
  }
  if (options.requiredFacts.includes('trusted-executable')) {
    if (evidence.executable.kind !== 'trusted' && evidence.executable.kind !== 'not-applicable') {
      return { kind: 'denied', reason: { kind: 'executable', fact: evidence.executable.kind } };
    }
  }
  if (options.requiredFacts.includes('compatible-version')) {
    if (
      evidence.compatibility.kind !== 'compatible' &&
      evidence.compatibility.kind !== 'not-applicable'
    ) {
      return {
        kind: 'denied',
        reason: { kind: 'compatibility', fact: evidence.compatibility.kind },
      };
    }
  }
  if (options.requiredFacts.includes('authentication')) {
    const authAdmission = admitAuthentication(options);
    if (authAdmission !== null) return authAdmission;
  }
  if (
    options.requiredFacts.includes('reachable-endpoint') &&
    evidence.endpoint.kind !== 'success'
  ) {
    return {
      kind: 'denied',
      reason: { kind: 'probe', fact: 'reachable-endpoint', outcome: evidence.endpoint.kind },
    };
  }
  if (options.requiredFacts.includes('catalog') && evidence.catalog.kind !== 'success') {
    return {
      kind: 'denied',
      reason: { kind: 'probe', fact: 'catalog', outcome: evidence.catalog.kind },
    };
  }
  if (options.requiredFacts.includes('model-run')) {
    if (
      evidence.modelRun.contextKey !== options.expectedContextKey ||
      evidence.modelRun.selectionId !== options.expectedSelectionId
    ) {
      return { kind: 'denied', reason: { kind: 'model-context-mismatch' } };
    }
    if (evidence.modelRun.kind !== 'verified-by-last-run') {
      return { kind: 'denied', reason: { kind: 'model-run', fact: evidence.modelRun.kind } };
    }
  }
  return { kind: 'admitted' };
}

/**
 * `unknown` is the honest steady state for a session credential no cheap check
 * can verify: a local status read or bridged-state presence proves a
 * credential exists, never that the server still honours it — only a real call
 * can. An interactive run therefore follows the `unverifiedAuth` policy for
 * every runner ('disclosed' admits with the unverified fact carried in the
 * readiness report; anything else surfaces it for review), while a headless
 * run stays fail-closed unless unverified auth was explicitly allowed.
 * Denying interactively — the old first-class-tier behaviour — punished the
 * honesty: it turned "cannot verify without spending a call" into a runner
 * that could never start.
 */
function admitAuthentication(options: StartAdmissionOptions): StartAdmission | null {
  const { auth } = options.evidence;
  if (auth === 'verified' || auth === 'not-required') return null;
  if (auth !== 'unknown') {
    return { kind: 'denied', reason: { kind: 'authentication', fact: auth } };
  }
  if (options.interaction === 'interactive') {
    if (options.unverifiedAuth === 'disclosed') return null;
    return { kind: 'disclosure-required', auth };
  }
  if (options.unverifiedAuth === 'allowed') return null;
  return { kind: 'denied', reason: { kind: 'authentication-unverified' } };
}
