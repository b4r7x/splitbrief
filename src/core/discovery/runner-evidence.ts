import type {
  CliToolDetection,
  DetectedModel,
  ExecutableIdentity,
  ProviderDetection,
} from './detection.js';
import {
  CliToolDetectionSchema,
  parseDigestBoundExecutableFingerprint,
  ProviderDetectionSchema,
} from './detection.js';
import { assertNever } from '../../utils/type-guards.js';

export type { ExecutableIdentity };

export const RUNNER_EVIDENCE_KINDS = ['cli', 'api', 'shell', 'agent', 'agent-sdk'] as const;
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
export type RunnerEvidenceSource = 'fresh' | 'cached' | 'legacy-projection';

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
  runnerTier: 'first-class' | 'compatibility';
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
 * Cached and legacy-projected evidence are always denied before any other fact
 * is considered.
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

function admitAuthentication(options: StartAdmissionOptions): StartAdmission | null {
  const { auth } = options.evidence;
  if (auth === 'verified' || auth === 'not-required') return null;
  if (auth !== 'unknown') {
    return { kind: 'denied', reason: { kind: 'authentication', fact: auth } };
  }
  if (options.interaction === 'headless' && options.unverifiedAuth === 'allowed') return null;
  if (options.interaction === 'interactive' && options.runnerTier === 'compatibility') {
    if (options.unverifiedAuth === 'disclosed') return null;
    return { kind: 'disclosure-required', auth };
  }
  return { kind: 'denied', reason: { kind: 'authentication-unverified' } };
}

/**
 * Projects the legacy CLI wire shape into evidence for presentation only. A
 * legacy `authenticated` field is deliberately downgraded to `unknown`: it
 * does not establish that a selected-channel auth probe was verified.
 */
export function runnerEvidenceFromCliToolDetection(detection: CliToolDetection): RunnerEvidence {
  const contextKey = `legacy:cli:${detection.tool}`;
  return {
    runner: {
      id: detection.tool,
      kind: 'cli',
      locality: 'unknown',
      enabled: detection.diagnostic.state === 'disabled' ? 'disabled' : 'enabled',
    },
    context: { key: contextKey, observedAt: detection.probedAt, source: 'legacy-projection' },
    installation: detection.diagnostic.state === 'unavailable' ? 'missing' : 'installed',
    executable: executableFactFromLegacy(detection),
    compatibility: compatibilityFactFromLegacy(detection),
    credential: 'unknown',
    auth: authFactFromLegacy(detection.auth),
    endpoint: { kind: 'not-run' },
    catalog: { kind: 'not-run' },
    modelRun: {
      kind: 'unknown',
      selectionId: 'legacy-unselected',
      observedAt: detection.probedAt,
      contextKey,
    },
  };
}

/**
 * Projects the legacy provider wire shape into evidence for presentation only.
 * `hasKey` becomes only a presence fact and never a verified authentication
 * result.
 */
export function runnerEvidenceFromProviderDetection(detection: ProviderDetection): RunnerEvidence {
  const contextKey = `legacy:api:${detection.provider}`;
  const credential =
    detection.hasKey === true ? 'present' : detection.hasKey === false ? 'absent' : 'unknown';
  return {
    runner: {
      id: detection.provider,
      kind: 'api',
      locality: detection.isLocal ? 'local' : 'remote',
      enabled: 'enabled',
    },
    context: { key: contextKey, observedAt: 0, source: 'legacy-projection' },
    installation: 'not-applicable',
    executable: { kind: 'not-applicable' },
    compatibility: { kind: 'not-applicable' },
    credential,
    auth: 'unknown',
    endpoint: detection.available ? { kind: 'success', value: null } : { kind: 'not-run' },
    catalog: detection.available
      ? { kind: 'success', value: detection.models ?? [] }
      : { kind: 'not-run' },
    modelRun: {
      kind: 'unknown',
      selectionId: 'legacy-unselected',
      observedAt: 0,
      contextKey,
    },
  };
}

type LegacyDetectionProjectionOptions = Readonly<{
  evidence: RunnerEvidence;
  remediationFor: (state: Exclude<CliToolDetection['diagnostic']['state'], 'ready'>) => string;
}>;

/**
 * Returns a legacy display projection. Its output is not a `RunnerEvidence`
 * and cannot be passed to `admitStart`.
 */
export function legacyDetectionFromRunnerEvidence(
  options: LegacyDetectionProjectionOptions,
): CliToolDetection | ProviderDetection | null {
  if (options.evidence.runner.kind === 'cli') {
    return cliToolDetectionFromRunnerEvidence(options);
  }
  if (options.evidence.runner.kind === 'api') {
    return providerDetectionFromRunnerEvidence(options.evidence);
  }
  return null;
}

function cliToolDetectionFromRunnerEvidence(
  options: LegacyDetectionProjectionOptions,
): CliToolDetection | null {
  const { evidence } = options;
  if (evidence.runner.kind !== 'cli') return null;
  const executable = legacyExecutableFromEvidence(evidence);
  const trust = legacyTrustFromEvidence(evidence, executable);
  const compatibility = legacyCompatibilityFromEvidence(evidence.compatibility);
  const auth = legacyAuthFromEvidence(evidence.auth);
  const state = legacyCliReadinessState({ evidence, executable, trust, compatibility, auth });
  const diagnostic =
    state === 'ready'
      ? { state, remediation: null }
      : { state, remediation: options.remediationFor(state) };
  const parsed = CliToolDetectionSchema.safeParse({
    tool: evidence.runner.id,
    executable,
    trust,
    installedVersion: compatibility.installedVersion,
    testedVersion: compatibility.testedVersion,
    compatibility: compatibility.kind,
    auth,
    diagnostic,
    probedAt: evidence.context.observedAt,
  });
  return parsed.success ? parsed.data : null;
}

/**
 * Returns a legacy display projection with credential presence only. The
 * projection omits raw error text and credential material.
 */
function providerDetectionFromRunnerEvidence(evidence: RunnerEvidence): ProviderDetection | null {
  if (evidence.runner.kind !== 'api') return null;
  const result = ProviderDetectionSchema.safeParse({
    provider: evidence.runner.id,
    available: evidence.catalog.kind === 'success',
    ...(evidence.catalog.kind === 'success' ? { models: evidence.catalog.value } : {}),
    isLocal: evidence.runner.locality === 'local',
    ...(evidence.credential === 'present'
      ? { hasKey: true }
      : evidence.credential === 'absent'
        ? { hasKey: false }
        : {}),
  });
  return result.success ? result.data : null;
}

function executableFactFromLegacy(detection: CliToolDetection): ExecutableFact {
  if (detection.executable === null) {
    return detection.trust === 'untrusted' ? { kind: 'untrusted' } : { kind: 'missing' };
  }
  if (detection.trust !== 'trusted') {
    return detection.trust === 'untrusted' ? { kind: 'untrusted' } : { kind: 'unknown' };
  }
  return { kind: 'unknown' };
}

function compatibilityFactFromLegacy(detection: CliToolDetection): CompatibilityFact {
  switch (detection.compatibility) {
    case 'compatible':
      if (detection.installedVersion === null) {
        return { kind: 'unknown', installedVersion: null, testedVersion: detection.testedVersion };
      }
      return {
        kind: 'compatible',
        installedVersion: detection.installedVersion,
        testedVersion: detection.testedVersion,
      };
    case 'incompatible':
      if (detection.installedVersion === null) {
        return { kind: 'unknown', installedVersion: null, testedVersion: detection.testedVersion };
      }
      return {
        kind: 'incompatible',
        installedVersion: detection.installedVersion,
        testedVersion: detection.testedVersion,
      };
    case 'unverified':
    case 'not-checked':
      return {
        kind: 'unknown',
        installedVersion: detection.installedVersion,
        testedVersion: detection.testedVersion,
      };
    default:
      return assertNever(detection.compatibility);
  }
}

function authFactFromLegacy(auth: CliToolDetection['auth']): AuthFact {
  switch (auth) {
    case 'authenticated':
      return 'unknown';
    case 'unauthenticated':
      return 'missing';
    case 'unknown':
      return 'unknown';
    case 'not-required':
      return 'not-required';
    case 'not-checked':
      return 'not-run';
    default:
      return assertNever(auth);
  }
}

function legacyExecutableFromEvidence(evidence: RunnerEvidence): CliToolDetection['executable'] {
  if (evidence.executable.kind !== 'trusted') return null;
  const fingerprint = parseDigestBoundExecutableFingerprint(
    evidence.executable.identity.fingerprint,
  );
  if (fingerprint === null) return null;
  return {
    path: evidence.executable.identity.canonicalPath,
    fingerprint,
  };
}

function legacyTrustFromEvidence(
  evidence: RunnerEvidence,
  executable: CliToolDetection['executable'],
): CliToolDetection['trust'] {
  if (evidence.executable.kind === 'untrusted' || evidence.executable.kind === 'identity-drifted') {
    return 'untrusted';
  }
  return executable === null ? 'not-checked' : 'trusted';
}

function legacyCompatibilityFromEvidence(compatibility: CompatibilityFact): Readonly<{
  kind: CliToolDetection['compatibility'];
  installedVersion: string | null;
  testedVersion: string;
}> {
  switch (compatibility.kind) {
    case 'compatible':
    case 'incompatible':
      return compatibility;
    case 'unknown':
      return { ...compatibility, kind: 'unverified' };
    case 'not-applicable':
      return { kind: 'not-checked', installedVersion: null, testedVersion: 'not-applicable' };
    default:
      return assertNever(compatibility);
  }
}

function legacyAuthFromEvidence(auth: AuthFact): CliToolDetection['auth'] {
  switch (auth) {
    case 'verified':
      return 'authenticated';
    case 'not-required':
      return 'not-required';
    case 'missing':
      return 'unauthenticated';
    case 'not-run':
      return 'not-checked';
    case 'not-selected':
    case 'unknown':
    case 'invalid':
    case 'policy-denied':
    case 'offline':
    case 'timeout':
    case 'malformed':
    case 'cancelled':
      return 'unknown';
    default:
      return assertNever(auth);
  }
}

function legacyCliReadinessState(
  input: Readonly<{
    evidence: RunnerEvidence;
    executable: CliToolDetection['executable'];
    trust: CliToolDetection['trust'];
    compatibility: ReturnType<typeof legacyCompatibilityFromEvidence>;
    auth: CliToolDetection['auth'];
  }>,
): CliToolDetection['diagnostic']['state'] {
  if (input.evidence.runner.enabled === 'disabled') return 'disabled';
  if (input.evidence.installation === 'missing' || input.executable === null) {
    return input.trust === 'untrusted' ? 'untrusted' : 'unavailable';
  }
  if (input.trust !== 'trusted') return 'untrusted';
  if (input.compatibility.kind === 'incompatible') return 'incompatible';
  if (input.compatibility.kind !== 'compatible') return 'unverified';
  if (input.auth === 'unauthenticated') return 'unauthenticated';
  if (input.auth !== 'authenticated' && input.auth !== 'not-required') return 'unverified';
  return 'ready';
}
