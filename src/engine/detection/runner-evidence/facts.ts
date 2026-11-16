import type { RunnerDiscoveryContext } from '../../../core/config/accessors/runner-discovery-context.js';
import {
  type CliExecutableIdentity,
  ExecutableIdentitySchema,
} from '../../../core/discovery/detection/executable.js';
import type { DetectedModel } from '../../../core/discovery/detection/model.js';
import type {
  ExecutableFact,
  ProbeOutcome,
  CompatibilityFact,
  AuthFact,
  CredentialPresence,
} from '../../../core/discovery/runner-evidence.js';
import type { CliCompatibility } from '../../../core/runners/cli-tool/types.js';
import { classifyCliAdmittedVersion } from '../../../core/runners/cli-tool/version.js';
import { assertNever } from '../../../utils/type-guards.js';
import { runnerDiscoveryContextKey } from '../context-key.js';
import type { RunnerEvidenceBase } from './types.js';

export function runnerEvidenceBase(
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

export function executableFactFromResolved(executable: CliExecutableIdentity): ExecutableFact {
  const attached = 'executableIdentity' in executable ? executable.executableIdentity : undefined;
  const result = ExecutableIdentitySchema.safeParse(attached);
  return result.success ? { kind: 'trusted', identity: result.data } : { kind: 'unknown' };
}

export function compatibilityFromVersion(
  input: Readonly<{
    version: ProbeOutcome<string>;
    compatibility: CliCompatibility;
  }>,
): CompatibilityFact {
  const testedVersion = input.compatibility.testedVersion;
  if (input.version.kind === 'timeout') {
    return { kind: 'timeout', installedVersion: null, testedVersion };
  }
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

export function credentialFromCliAuth(
  context: RunnerDiscoveryContext,
  auth: AuthFact,
): CredentialPresence {
  if (context.credentialPresent) return 'present';
  switch (auth) {
    case 'missing':
    case 'keyring':
      return 'absent';
    case 'verified':
    case 'invalid':
      return 'present';
    case 'not-required':
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

export function modelRunFromCatalog(
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
