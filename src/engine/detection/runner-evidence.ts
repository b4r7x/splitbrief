import type { RunnerDiscoveryContext } from '../../core/config/accessors/runner-discovery-context.js';
import type { CliExecutableIdentity, DetectedModel } from '../../core/discovery/detection.js';
import { ExecutableIdentitySchema } from '../../core/discovery/detection.js';
import type {
  AuthFact,
  CompatibilityFact,
  CredentialPresence,
  ExecutableFact,
  ProbeOutcome,
  RunnerEvidence,
} from '../../core/discovery/runner-evidence.js';
import {
  CLI_TOOL_CATALOG,
  CLI_TOOL_IDS,
  type CliCompatibility,
} from '../../core/runners/cli-tool-catalog.js';
import { classifyCliAdmittedVersion } from '../../core/runners/cli-version.js';
import type { CliReadinessResult } from '../../core/schemas/readiness.js';
import { matches } from '../../utils/error.js';
import { abortError, throwIfAborted } from '../../utils/abort.js';
import { assertNever, includes } from '../../utils/type-guards.js';
import {
  resolveCliExecutable,
  resolveCliExecutableAliases,
  type CliExecutableResolver,
} from '../runners/resolve-cli-executable.js';
import {
  isCanonicalCliDeclaredProbe,
  lookupCliReadinessProbe,
} from '../runners/cli-tools/registry.js';
import {
  probeCliReadiness,
  probeDeclaredCliReadinessEvidence,
  type AuthProbeRun,
} from '../runners/cli-tools/readiness-probe.js';
import { isDeclaredCliProbeContract } from '../runners/cli-tools/contract.js';
import { probeContextCatalog } from './catalog-probe.js';
import {
  immutableCliExecutableIdentity,
  isCredentialFreeCliContext,
  snapshotCliContext,
  type CliRunnerDiscoveryContext,
} from './cli-context.js';

type ResolveCliExecutable = CliExecutableResolver;
type ProbeDeclaredCliReadinessEvidence = typeof probeDeclaredCliReadinessEvidence;
type LookupCliReadinessProbe = typeof lookupCliReadinessProbe;

type RunnerEvidenceBase = Pick<
  RunnerEvidence,
  'runner' | 'context' | 'endpoint' | 'catalog' | 'modelRun'
>;

export interface DetectRunnerEvidenceOptions {
  context: RunnerDiscoveryContext;
  projectDir?: string | undefined;
  /** A test resolver may select only a real receipt; catalog work revalidates it before every run. */
  resolveExecutable?: ResolveCliExecutable | undefined;
  /** Readiness-only test seam. It is ignored whenever catalog discovery is requested. */
  lookupProbe?: LookupCliReadinessProbe | undefined;
  /** Readiness-only test seam. It is ignored whenever catalog discovery is requested. */
  probeDeclaredReadiness?: ProbeDeclaredCliReadinessEvidence | undefined;
  includeCatalog?: boolean | undefined;
  catalogRefresh?: 'automatic' | 'manual' | undefined;
  /**
   * The model list names `projectDir`, so it carries the providers the project's
   * own tool config sets up. OpenCode loads that config, its plugins and its MCP
   * servers to answer, so only a read for a tool the crew uses sets it.
   */
  catalogNamesProject?: boolean | undefined;
  /** Observation-only catalog attribution handoff; receives an immutable receipt snapshot. */
  onResolvedCliExecutable?: ((executable: CliExecutableIdentity) => void) | undefined;
  now?: (() => number) | undefined;
  signal?: AbortSignal | undefined;
}

/**
 * Binds evidence to one active selection without serializing credential values.
 * Start derives this from config instead of trusting a returned evidence key.
 * The seat that asked and the complete endpoint are part of that selection:
 * reviewer and planner share an admission role but never an identity, and a
 * second base path on the same origin is a second endpoint. A legacy context
 * carries neither and keys on its admission role alone.
 */
export function runnerDiscoveryContextKey(context: RunnerDiscoveryContext): string {
  const credentialDomain = context.credentialDomain;
  const credentialDomainParts =
    credentialDomain === undefined
      ? ['credential-domain', 'absent']
      : [
          'credential-domain',
          'present',
          credentialDomain.providerId,
          credentialDomain.endpointOrigin,
          credentialDomain.authChannel,
          credentialDomain.credentialSource.kind,
          credentialDomain.credentialSource.kind === 'env'
            ? credentialDomain.credentialSource.name
            : credentialDomain.credentialSource.configNodeId,
          credentialDomain.credentialSource.kind === 'env'
            ? (credentialDomain.credentialSource.valueIdentity ?? 'unknown')
            : 'inline',
          credentialDomain.configGeneration,
        ];
  return [
    'runner-evidence-v2',
    context.role,
    context.seatRole ?? context.role,
    context.kind,
    context.id,
    context.model ?? 'unselected',
    context.authChannel ?? 'not-selected',
    context.endpointOrigin ?? 'none',
    context.endpointIdentity ?? 'none',
    context.credentialPresent ? 'credential-present' : 'credential-absent',
    ...credentialDomainParts,
    context.configGeneration,
  ]
    .map((part) => encodeURIComponent(part))
    .join('|');
}

interface SharedProbe<Value> {
  readonly controller: AbortController;
  readonly promise: Promise<Value>;
  subscribers: number;
}

export interface InFlightProbeSharing<Value> {
  share(
    input: Readonly<{
      key: string | undefined;
      signal?: AbortSignal | undefined;
      run: (signal: AbortSignal | undefined) => Promise<Value>;
    }>,
  ): Promise<Value>;
}

function awaitSharedProbe<Value>(
  entry: SharedProbe<Value>,
  signal: AbortSignal | undefined,
): Promise<Value> {
  if (signal === undefined) return entry.promise;
  const release = new AbortController();
  const cancelled = new Promise<never>((_, reject) => {
    signal.addEventListener('abort', () => reject(abortError(signal)), {
      once: true,
      signal: release.signal,
    });
  });
  return Promise.race([entry.promise, cancelled]).finally(() => release.abort());
}

/**
 * One read-only probe may serve every caller asking the identical question at
 * the same moment, and nothing else: the key names the observation, never a
 * caller's preparation receipt, and settlement — resolution or rejection —
 * evicts the entry, so the next caller probes afresh instead of inheriting
 * remembered authority. An observation with no shareable identity passes
 * `key: undefined` and always probes alone. Each subscriber cancels only its
 * own wait; the shared work is aborted once the last subscriber has left.
 */
export function createInFlightProbeSharing<Value>(): InFlightProbeSharing<Value> {
  const entries = new Map<string | symbol, SharedProbe<Value>>();

  function start(
    key: string | symbol,
    run: (signal: AbortSignal | undefined) => Promise<Value>,
  ): SharedProbe<Value> {
    const controller = new AbortController();
    const entry: SharedProbe<Value> = {
      controller,
      promise: run(controller.signal),
      subscribers: 0,
    };
    entries.set(key, entry);
    const evict = (): void => {
      if (entries.get(key) === entry) entries.delete(key);
    };
    entry.promise.then(evict, evict);
    return entry;
  }

  return {
    async share(input) {
      const key = input.key ?? Symbol();
      throwIfAborted(input.signal);
      const entry = entries.get(key) ?? start(key, input.run);
      entry.subscribers += 1;
      try {
        return await awaitSharedProbe(entry, input.signal);
      } finally {
        entry.subscribers -= 1;
        if (entry.subscribers === 0 && entries.get(key) === entry) {
          entries.delete(key);
          entry.controller.abort();
        }
      }
    },
  };
}

const cliEvidenceProbes = createInFlightProbeSharing<RunnerEvidence>();

function runnerEvidenceBase(
  context: RunnerDiscoveryContext,
  observedAt: number,
): RunnerEvidenceBase {
  const contextKey = runnerDiscoveryContextKey(context);
  return {
    runner: {
      id: context.id,
      kind: context.kind,
      locality: 'unknown',
      enabled: 'enabled',
    },
    context: { key: contextKey, observedAt, source: 'fresh' },
    endpoint: { kind: 'not-run' },
    catalog: { kind: 'not-run' },
    modelRun: {
      kind: 'unknown',
      selectionId: context.model ?? 'unselected',
      observedAt,
      contextKey,
    },
  };
}

function isCliContext(context: RunnerDiscoveryContext): context is CliRunnerDiscoveryContext {
  return context.kind === 'cli' && includes(CLI_TOOL_IDS, context.id);
}

function nonCliRunnerEvidence(context: RunnerDiscoveryContext, observedAt: number): RunnerEvidence {
  const base = runnerEvidenceBase(context, observedAt);
  switch (context.kind) {
    case 'api':
      return {
        ...base,
        installation: 'not-applicable',
        executable: { kind: 'not-applicable' },
        compatibility: { kind: 'not-applicable' },
        credential: context.credentialPresent ? 'present' : 'absent',
        auth: context.credentialPresent ? 'unknown' : 'missing',
      };
    case 'shell':
    case 'agent':
      return {
        ...base,
        installation: 'not-applicable',
        executable: { kind: 'not-applicable' },
        compatibility: { kind: 'not-applicable' },
        credential: 'not-applicable',
        auth: 'not-required',
      };
    case 'cli':
      return {
        ...base,
        installation: 'unknown',
        executable: { kind: 'unknown' },
        compatibility: {
          kind: 'unknown',
          installedVersion: null,
          testedVersion: 'unknown',
        },
        credential: 'unknown',
        auth: context.authChannel === undefined ? 'not-selected' : 'unknown',
      };
    default:
      return assertNever(context.kind);
  }
}

function executableFactFromResolved(executable: CliExecutableIdentity): ExecutableFact {
  const attached = 'executableIdentity' in executable ? executable.executableIdentity : undefined;
  const result = ExecutableIdentitySchema.safeParse(attached);
  return result.success ? { kind: 'trusted', identity: result.data } : { kind: 'unknown' };
}

function compatibilityFromVersion(
  input: Readonly<{
    version: ProbeOutcome<string>;
    compatibility: CliCompatibility;
  }>,
): CompatibilityFact {
  const testedVersion = input.compatibility.testedVersion;
  if (input.version.kind !== 'success') {
    return { kind: 'unknown', installedVersion: null, testedVersion };
  }
  switch (
    classifyCliAdmittedVersion({
      installedVersion: input.version.value,
      minimumAdmittedVersion: input.compatibility.minimumAdmittedVersion,
      versionScheme: input.compatibility.versionScheme,
    })
  ) {
    case 'compatible':
      return { kind: 'compatible', installedVersion: input.version.value, testedVersion };
    case 'incompatible':
      return { kind: 'incompatible', installedVersion: input.version.value, testedVersion };
    case 'unverified':
      return { kind: 'unknown', installedVersion: input.version.value, testedVersion };
  }
}

function credentialFromCliAuth(
  context: RunnerDiscoveryContext,
  auth: AuthFact,
): CredentialPresence {
  if (context.credentialPresent) return 'present';
  switch (auth) {
    case 'missing':
      return 'absent';
    case 'verified':
    case 'invalid':
      return 'present';
    case 'not-required':
    case 'not-selected':
    case 'unknown':
    case 'policy-denied':
    case 'offline':
    case 'timeout':
    case 'malformed':
    case 'cancelled':
    case 'not-run':
      return 'unknown';
    default:
      return assertNever(auth);
  }
}

function modelRunFromCatalog(
  context: RunnerDiscoveryContext,
  base: RunnerEvidenceBase,
  catalog: ProbeOutcome<readonly DetectedModel[]>,
) {
  if (
    context.model !== undefined &&
    catalog.kind === 'success' &&
    catalog.value.some((model) => model.id === context.model)
  ) {
    return {
      kind: 'listed-unverified' as const,
      selectionId: context.model,
      observedAt: base.context.observedAt,
      contextKey: base.context.key,
    };
  }
  return base.modelRun;
}

function legacyAuthFact(auth: CliReadinessResult['auth']): AuthFact {
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

function compatibilityFromLegacy(readiness: CliReadinessResult): CompatibilityFact {
  switch (readiness.compatibility) {
    case 'compatible':
    case 'incompatible':
      return readiness.installedVersion === null
        ? {
            kind: 'unknown',
            installedVersion: null,
            testedVersion: readiness.testedVersion,
          }
        : {
            kind: readiness.compatibility,
            installedVersion: readiness.installedVersion,
            testedVersion: readiness.testedVersion,
          };
    case 'unverified':
    case 'not-checked':
      return {
        kind: 'unknown',
        installedVersion: readiness.installedVersion,
        testedVersion: readiness.testedVersion,
      };
    default:
      return assertNever(readiness.compatibility);
  }
}

function executableFactFromLegacyReadiness(readiness: CliReadinessResult): ExecutableFact {
  if (readiness.trust === 'untrusted') return { kind: 'untrusted' };
  if (readiness.executable === null) {
    return readiness.installation === 'unavailable' ? { kind: 'missing' } : { kind: 'unknown' };
  }
  return readiness.trust === 'trusted'
    ? executableFactFromResolved(readiness.executable)
    : { kind: 'unknown' };
}

function evidenceFromLegacyReadiness(
  context: RunnerDiscoveryContext,
  observedAt: number,
  readiness: CliReadinessResult,
): RunnerEvidence {
  const base = runnerEvidenceBase(context, observedAt);
  const auth = legacyAuthFact(readiness.auth);
  return {
    ...base,
    installation: readiness.installation === 'installed' ? 'installed' : 'missing',
    executable: executableFactFromLegacyReadiness(readiness),
    compatibility: compatibilityFromLegacy(readiness),
    credential: credentialFromCliAuth(context, auth),
    auth,
    ...(readiness.providerAuth !== undefined && { providerAuth: readiness.providerAuth }),
  };
}

function unresolvedCliEvidence(
  context: CliRunnerDiscoveryContext,
  observedAt: number,
  cause: unknown,
): RunnerEvidence {
  const base = runnerEvidenceBase(context, observedAt);
  if (matches('cli-executable-untrusted')(cause)) {
    return {
      ...base,
      installation: 'installed',
      executable: { kind: 'untrusted' },
      compatibility: {
        kind: 'unknown',
        installedVersion: null,
        testedVersion: CLI_TOOL_CATALOG[context.id].compatibility.testedVersion,
      },
      credential: 'unknown',
      auth: context.authChannel === undefined ? 'not-selected' : 'not-run',
    };
  }
  if (matches('cli-executable-identity-drift')(cause)) {
    return {
      ...base,
      installation: 'installed',
      executable: { kind: 'identity-drifted' },
      compatibility: {
        kind: 'unknown',
        installedVersion: null,
        testedVersion: CLI_TOOL_CATALOG[context.id].compatibility.testedVersion,
      },
      credential: 'unknown',
      auth: 'cancelled',
    };
  }
  if (matches('cli-executable-unavailable')(cause)) {
    return {
      ...base,
      installation: 'missing',
      executable: { kind: 'missing' },
      compatibility: {
        kind: 'unknown',
        installedVersion: null,
        testedVersion: CLI_TOOL_CATALOG[context.id].compatibility.testedVersion,
      },
      credential: 'unknown',
      auth: context.authChannel === undefined ? 'not-selected' : 'not-run',
    };
  }
  return {
    ...base,
    installation: 'unknown',
    executable: { kind: 'unknown' },
    compatibility: {
      kind: 'unknown',
      installedVersion: null,
      testedVersion: CLI_TOOL_CATALOG[context.id].compatibility.testedVersion,
    },
    credential: 'unknown',
    auth: context.authChannel === undefined ? 'not-selected' : 'unknown',
  };
}

function probeFailureEvidence(
  context: CliRunnerDiscoveryContext,
  observedAt: number,
  executable: CliExecutableIdentity,
): RunnerEvidence {
  const base = runnerEvidenceBase(context, observedAt);
  return {
    ...base,
    installation: 'installed',
    executable: executableFactFromResolved(executable),
    compatibility: {
      kind: 'unknown',
      installedVersion: null,
      testedVersion: CLI_TOOL_CATALOG[context.id].compatibility.testedVersion,
    },
    credential: context.credentialPresent ? 'present' : 'unknown',
    auth: context.authChannel === undefined ? 'not-selected' : 'unknown',
  };
}

function unsupportedCatalogEvidence(
  context: CliRunnerDiscoveryContext,
  observedAt: number,
  executable: CliExecutableIdentity,
): RunnerEvidence {
  const base = runnerEvidenceBase(context, observedAt);
  return {
    ...base,
    installation: 'installed',
    executable: executableFactFromResolved(executable),
    compatibility: {
      kind: 'unknown',
      installedVersion: null,
      testedVersion: CLI_TOOL_CATALOG[context.id].compatibility.testedVersion,
    },
    credential: context.credentialPresent ? 'present' : 'unknown',
    auth: context.authChannel === undefined ? 'not-selected' : 'not-run',
    catalog: { kind: 'unsupported' },
  };
}

/**
 * The probe work behind one resolved executable: version, auth and — only when
 * asked — the catalog. Each call owns its cancellation boundary.
 */
async function probeResolvedCliEvidence(
  options: DetectRunnerEvidenceOptions,
  input: Readonly<{
    context: CliRunnerDiscoveryContext;
    observedAt: number;
    executable: CliExecutableIdentity;
    signal: AbortSignal | undefined;
  }>,
): Promise<RunnerEvidence> {
  const { context, observedAt, executable, signal } = input;
  const now = options.now ?? Date.now;
  const catalogRequested = options.includeCatalog === true;

  const probe = (
    catalogRequested ? lookupCliReadinessProbe : (options.lookupProbe ?? lookupCliReadinessProbe)
  )({
    tool: context.id,
    role: context.role,
  });
  if (
    catalogRequested &&
    (!isDeclaredCliProbeContract(probe) ||
      !isCanonicalCliDeclaredProbe({
        tool: context.id,
        role: context.role,
        probe: probe.declared,
      }))
  ) {
    return unsupportedCatalogEvidence(context, observedAt, executable);
  }
  if (!isDeclaredCliProbeContract(probe)) {
    try {
      const readiness = await probeCliReadiness({
        tool: context.id,
        executable,
        probe,
        ...(context.authChannel !== undefined ? { authChannel: context.authChannel } : {}),
        ...(signal !== undefined ? { signal } : {}),
        now: () => observedAt,
        classifyVersion: ({ installedVersion }) =>
          classifyCliAdmittedVersion({
            installedVersion,
            minimumAdmittedVersion:
              CLI_TOOL_CATALOG[context.id].compatibility.minimumAdmittedVersion,
            versionScheme: CLI_TOOL_CATALOG[context.id].compatibility.versionScheme,
          }),
      });
      return evidenceFromLegacyReadiness(context, observedAt, readiness);
    } catch {
      throwIfAborted(signal);
      return probeFailureEvidence(context, observedAt, executable);
    }
  }

  let authProbeRun: AuthProbeRun | undefined;
  const declaredProbeOptions = {
    tool: context.id,
    executable,
    probe: probe.declared,
    ...(context.authChannel !== undefined ? { authChannel: context.authChannel } : {}),
    ...(signal !== undefined ? { signal } : {}),
    // A tool whose auth oracle is its model listing (`agy models`) is spawned once per pass.
    ...(catalogRequested
      ? {
          onAuthProbeRun: (run: AuthProbeRun) => {
            authProbeRun = run;
          },
        }
      : {}),
  };
  const declaredReadiness = catalogRequested
    ? probeDeclaredCliReadinessEvidence
    : (options.probeDeclaredReadiness ?? probeDeclaredCliReadinessEvidence);
  let declaredEvidence: Awaited<ReturnType<ProbeDeclaredCliReadinessEvidence>>;
  try {
    declaredEvidence = await declaredReadiness(declaredProbeOptions);
  } catch {
    throwIfAborted(signal);
    return probeFailureEvidence(context, observedAt, executable);
  }

  if (declaredEvidence.version.kind === 'cancelled' || declaredEvidence.auth === 'cancelled') {
    const base = runnerEvidenceBase(context, observedAt);
    return {
      ...base,
      installation: 'installed',
      executable: { kind: 'identity-drifted' },
      compatibility: {
        kind: 'unknown',
        installedVersion: null,
        testedVersion: CLI_TOOL_CATALOG[context.id].compatibility.testedVersion,
      },
      credential: credentialFromCliAuth(context, declaredEvidence.auth),
      auth: declaredEvidence.auth,
    };
  }

  const executableFact = executableFactFromResolved(executable);
  const compatibility = compatibilityFromVersion({
    version: declaredEvidence.version,
    compatibility: CLI_TOOL_CATALOG[context.id].compatibility,
  });
  let catalog: ProbeOutcome<readonly DetectedModel[]>;
  if (!catalogRequested) {
    catalog = { kind: 'not-run' };
  } else if (executableFact.kind !== 'trusted' || compatibility.kind !== 'compatible') {
    catalog = { kind: 'unsupported' };
  } else {
    try {
      catalog = await probeContextCatalog({
        context,
        executable,
        probe: probe.declared,
        version: declaredEvidence.version,
        refresh: options.catalogRefresh ?? 'automatic',
        projectDir: options.projectDir ?? process.cwd(),
        namesProject: options.catalogNamesProject === true,
        now,
        signal,
        authProbeRun,
      });
    } catch {
      throwIfAborted(signal);
      return probeFailureEvidence(context, observedAt, executable);
    }
  }
  const base = runnerEvidenceBase(context, observedAt);
  return {
    ...base,
    installation: 'installed',
    executable: executableFact,
    compatibility,
    credential: credentialFromCliAuth(context, declaredEvidence.auth),
    auth: declaredEvidence.auth,
    catalog,
    modelRun: modelRunFromCatalog(context, base, catalog),
    ...(declaredEvidence.providerAuth !== undefined && {
      providerAuth: declaredEvidence.providerAuth,
    }),
  };
}

/**
 * Probes exactly one sanitized active-runner context. It never chooses an auth
 * channel, runs a catalog unless requested, or returns probe output. Resolving
 * and attributing the executable happens per caller. Native auth has no reliable
 * freshness identity, so concurrent calls each obtain their own observation.
 */
export async function detectRunnerEvidence(
  options: DetectRunnerEvidenceOptions,
): Promise<RunnerEvidence> {
  throwIfAborted(options.signal);
  const now = options.now ?? Date.now;
  const observedAt = now();
  if (!isCliContext(options.context)) return nonCliRunnerEvidence(options.context, observedAt);

  const context = snapshotCliContext(options.context);
  if (!isCredentialFreeCliContext(context)) return nonCliRunnerEvidence(context, observedAt);
  const projectDir = options.projectDir ?? process.cwd();
  const resolveExecutable = options.resolveExecutable ?? resolveCliExecutable;
  let executable: CliExecutableIdentity;
  try {
    const resolvedExecutable = (
      await resolveCliExecutableAliases({
        commands: CLI_TOOL_CATALOG[context.id].executableAliases,
        projectDir,
        resolveExecutable,
      })
    ).executable;
    executable = immutableCliExecutableIdentity(resolvedExecutable);
  } catch (cause) {
    throwIfAborted(options.signal);
    return unresolvedCliEvidence(context, observedAt, cause);
  }
  options.onResolvedCliExecutable?.(executable);

  return cliEvidenceProbes.share({
    // Selecting a native auth channel does not identify the account/session
    // currently behind it. Keep its cancellation boundary, but never reuse it.
    key: undefined,
    signal: options.signal,
    run: (probeSignal) =>
      probeResolvedCliEvidence(options, { context, observedAt, executable, signal: probeSignal }),
  });
}
