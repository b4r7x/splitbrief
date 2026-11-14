import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CliProviderAuth } from '../../../../core/discovery/detection/auth.js';
import type { CliExecutableIdentity } from '../../../../core/discovery/detection/executable.js';
import type { CliAuthState } from '../../../../core/discovery/detection/tool.js';
import { deriveCliReadiness } from '../../../../core/readiness/cli-remediation.js';
import { CLI_TOOL_CATALOG } from '../../../../core/runners/cli-tool/catalog.js';
import type { CliToolId } from '../../../../core/runners/cli-tool/types.js';
import type { CliReadinessResult } from '../../../../core/schemas/readiness.js';
import { throwIfAborted } from '../../../../utils/abort.js';
import { trackProbe } from '../../../probe-activity.js';
import { revalidateCliExecutableIdentity } from '../../cli-executable/identity.js';
import { removeSandboxTempDirs } from '../../sandbox/state/paths.js';
import { type CliProbeContract, isDeclaredCliProbeContract } from './contract.js';
import { probeDeclaredCliReadinessEvidence } from './declared-readiness.js';
import {
  untrustedResult,
  legacyAuthState,
  extractVersion,
  readinessExecutable,
} from './evidence.js';
import { probeEnvironment, runProbe } from './process.js';
import { providerOracleCommand } from './provider-oracle.js';

export interface ProbeCliReadinessOptions {
  tool: CliToolId;
  executable: CliExecutableIdentity | null;
  probe: CliProbeContract;
  enabled?: boolean | undefined;
  now?: (() => number) | undefined;
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
  const probedAt = (options.now ?? Date.now)();
  const base = {
    tool: options.tool,
    enabled: options.enabled ?? true,
    testedVersion: descriptor.compatibility.testedVersion,
    probedAt,
  } as const;
  if (!base.enabled || options.executable === null) {
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

  let installedVersion: string | null;
  let versionTimedOut: boolean;
  let auth: CliAuthState;
  let providerAuth: CliProviderAuth | undefined;
  if (isDeclaredCliProbeContract(options.probe)) {
    const evidence = await probeDeclaredCliReadinessEvidence({
      tool: options.tool,
      executable: options.executable,
      probe: options.probe.declared,
      enabled: base.enabled,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });
    installedVersion = evidence.version.kind === 'success' ? evidence.version.value : null;
    versionTimedOut = evidence.version.kind === 'timeout';
    auth = legacyAuthState(evidence.auth);
    providerAuth = evidence.providerAuth;
  } else {
    const executable = options.executable;
    const neutralDir = await mkdtemp(join(tmpdir(), 'splitbrief-readiness-'));
    try {
      const environment = await probeEnvironment({
        executable,
        neutralDir,
        tool: options.tool,
        channel: undefined,
      });
      const versionProbe = await trackProbe({ tool: options.tool, check: 'version' }, () =>
        runProbe({
          executable,
          command: options.probe.version,
          cwd: neutralDir,
          env: environment.env,
          signal: options.signal,
        }),
      );
      installedVersion = extractVersion(versionProbe);
      versionTimedOut = versionProbe.timedOut;
      auth = 'unknown';
    } finally {
      await rm(neutralDir, { recursive: true, force: true });
      removeSandboxTempDirs(neutralDir);
    }
  }
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
