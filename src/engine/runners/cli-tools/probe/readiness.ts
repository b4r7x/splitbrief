import type { CliExecutableIdentity } from '../../../../core/discovery/detection/executable.js';
import { deriveCliReadiness } from '../../../../core/readiness/cli-remediation.js';
import { CLI_TOOL_CATALOG } from '../../../../core/runners/cli-tool/catalog.js';
import type { CliToolId } from '../../../../core/runners/cli-tool/types.js';
import type { CliReadinessResult } from '../../../../core/schemas/readiness.js';
import { throwIfAborted } from '../../../../utils/abort.js';
import { revalidateCliExecutableIdentity } from '../../cli-executable/identity.js';
import type { CliDeclaredProbeContract } from './contract.js';
import { probeDeclaredCliReadinessEvidence } from './declared-readiness.js';
import { untrustedResult, legacyAuthState, readinessExecutable } from './evidence.js';
import { providerOracleCommand } from './provider-oracle.js';

export interface ProbeCliReadinessOptions {
  tool: CliToolId;
  executable: CliExecutableIdentity | null;
  probe: CliDeclaredProbeContract;
  signal?: AbortSignal | undefined;
  classifyVersion?:
    | ((input: {
        installedVersion: string;
        testedVersion: string;
      }) => 'compatible' | 'incompatible' | 'unverified')
    | undefined;
}

export async function probeCliReadiness(
  options: ProbeCliReadinessOptions,
): Promise<CliReadinessResult> {
  throwIfAborted(options.signal);
  const descriptor = CLI_TOOL_CATALOG[options.tool];
  const probedAt = Date.now();
  const base = {
    tool: options.tool,
    enabled: true,
    testedVersion: descriptor.compatibility.testedVersion,
    probedAt,
  } as const;
  if (options.executable === null) {
    return deriveCliReadiness({
      ...base,
      installation: 'unavailable',
      executable: null,
      trust: 'not-checked',
      installedVersion: null,
      compatibility: 'not-checked',
      auth: 'not-checked',
    });
  }
  if ((await revalidateCliExecutableIdentity(options.executable)) !== 'match') {
    return untrustedResult({ base, executable: options.executable, installedVersion: null });
  }

  const evidence = await probeDeclaredCliReadinessEvidence({
    tool: options.tool,
    executable: options.executable,
    probe: options.probe,
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  });
  const installedVersion = evidence.version.kind === 'success' ? evidence.version.value : null;
  const versionTimedOut = evidence.version.kind === 'timeout';
  const auth = legacyAuthState(evidence.auth);
  const providerAuth = evidence.providerAuth;
  if ((await revalidateCliExecutableIdentity(options.executable)) !== 'match') {
    return untrustedResult({
      base,
      executable: options.executable,
      installedVersion,
    });
  }
  // An oracle tool whose listing did not run carries the same fact live as it
  // does after a cache reload (`normalizeProviderAuth`): it was not probed. An
  // incompatible version is the one case where the version itself is the reason.
  const oracleTool = providerOracleCommand(options.tool) !== undefined;
  if (installedVersion === null) {
    const unversionedProviderAuth =
      providerAuth ??
      (oracleTool ? ({ kind: 'unreadable', reason: 'not-probed' } as const) : undefined);
    return deriveCliReadiness({
      ...base,
      installation: 'installed',
      executable: readinessExecutable(options.executable),
      trust: 'trusted',
      installedVersion,
      compatibility: versionTimedOut ? 'timeout' : 'unverified',
      auth,
      ...(unversionedProviderAuth === undefined ? {} : { providerAuth: unversionedProviderAuth }),
    });
  }
  const compatibility = options.classifyVersion
    ? options.classifyVersion({ installedVersion, testedVersion: base.testedVersion })
    : installedVersion === base.testedVersion
      ? 'compatible'
      : 'unverified';
  const resolvedProviderAuth =
    providerAuth ??
    (oracleTool
      ? ({
          kind: 'unreadable',
          reason: compatibility === 'incompatible' ? 'version-mismatch' : 'not-probed',
        } as const)
      : undefined);
  return deriveCliReadiness({
    ...base,
    installation: 'installed',
    executable: readinessExecutable(options.executable),
    trust: 'trusted',
    installedVersion,
    compatibility,
    auth: compatibility === 'compatible' ? auth : 'not-checked',
    ...(resolvedProviderAuth === undefined ? {} : { providerAuth: resolvedProviderAuth }),
  });
}
