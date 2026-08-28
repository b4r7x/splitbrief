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
  classifyCliAdmittedVersion,
  type CliCompatibility,
} from '../../core/runners/cli-tool-catalog.js';
import type { CliReadinessResult } from '../../core/schemas/readiness.js';
import { matches } from '../../utils/error.js';
import { throwIfAborted } from '../../utils/abort.js';
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
  /** Observation-only catalog attribution handoff; receives an immutable receipt snapshot. */
  onResolvedCliExecutable?: ((executable: CliExecutableIdentity) => void) | undefined;
  now?: (() => number) | undefined;
  signal?: AbortSignal | undefined;
}

/**
 * Binds evidence to one active selection without serializing credential values.
 * Start derives this from config instead of trusting a returned evidence key.
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
          credentialDomain.configGeneration,
        ];
  return [
    'runner-evidence-v1',
    context.role,
    context.kind,
    context.id,
    context.model ?? 'unselected',
    context.authChannel ?? 'not-selected',
    context.endpointOrigin ?? 'none',
    context.credentialPresent ? 'credential-present' : 'credential-absent',
    ...credentialDomainParts,
    context.configGeneration,
  ]
    .map((part) => encodeURIComponent(part))
    .join('|');
}

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
    case 'agent-sdk':
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
 * Probes exactly one sanitized active-runner context. It never chooses an auth
 * channel, runs a catalog unless requested, or returns probe output.
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
  const catalogRequested = options.includeCatalog === true;
  const resolveExecutable = options.resolveExecutable ?? resolveCliExecutable;
  let executable: CliExecutableIdentity;
  try {
    const resolvedExecutable = (
      await resolveCliExecutableAliases({
        commands: CLI_TOOL_CATALOG[context.id].executableAliases,
        projectDir: options.projectDir ?? process.cwd(),
        resolveExecutable,
      })
    ).executable;
    executable = immutableCliExecutableIdentity(resolvedExecutable);
  } catch (cause) {
    throwIfAborted(options.signal);
    return unresolvedCliEvidence(context, observedAt, cause);
  }
  options.onResolvedCliExecutable?.(executable);

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
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
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
      throwIfAborted(options.signal);
      return probeFailureEvidence(context, observedAt, executable);
    }
  }

  const declaredProbeOptions = {
    tool: context.id,
    executable,
    probe: probe.declared,
    ...(context.authChannel !== undefined ? { authChannel: context.authChannel } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  };
  const declaredReadiness = catalogRequested
    ? probeDeclaredCliReadinessEvidence
    : (options.probeDeclaredReadiness ?? probeDeclaredCliReadinessEvidence);
  let declaredEvidence: Awaited<ReturnType<ProbeDeclaredCliReadinessEvidence>>;
  try {
    declaredEvidence = await declaredReadiness(declaredProbeOptions);
  } catch {
    throwIfAborted(options.signal);
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
        now,
        signal: options.signal,
      });
    } catch {
      throwIfAborted(options.signal);
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
  };
}
