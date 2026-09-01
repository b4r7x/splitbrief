import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  CliAuthState,
  CliExecutableIdentity,
  CliProviderAuth,
} from '../../../core/discovery/detection.js';
import {
  CLI_TOOL_CATALOG,
  selectCliAuthChannel,
  type CliAuthChannel,
  type CliAuthChannelId,
  type CliToolId,
} from '../../../core/runners/cli-tool-catalog.js';
import { deriveCliReadiness, type CliReadinessResult } from '../../../core/schemas/readiness.js';
import { throwIfAborted } from '../../../utils/abort.js';
import {
  authFactFromDeclaredProbe,
  extractVersion,
  legacyAuthState,
  oracleAuthEvidence,
  readinessExecutable,
  untrustedResult,
  versionOutcomeFromProbe,
  type CliReadinessProbeEvidence,
} from './cli-probe-evidence.js';
import {
  declaredAuthProbeIsSafe,
  hasForbiddenProbeArgument,
  probeEnvironment,
  runProbe,
} from './cli-probe-process.js';
import {
  isDeclaredCliProbeContract,
  type CliDeclaredProbeContract,
  type CliProbeContract,
} from './contract.js';
import { isProviderOracleProbe, providerOracleCommand } from './provider-oracle.js';
import { revalidateCliExecutableIdentity } from '../resolve-cli-executable.js';

export interface ProbeCliReadinessOptions {
  tool: CliToolId;
  executable: CliExecutableIdentity | null;
  probe: CliProbeContract;
  authChannel?: CliAuthChannelId | undefined;
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

export type ProbeDeclaredCliReadinessEvidenceOptions = Readonly<{
  tool: CliToolId;
  executable: CliExecutableIdentity | null;
  probe: CliDeclaredProbeContract;
  authChannel?: CliAuthChannelId | undefined;
  enabled?: boolean | undefined;
  signal?: AbortSignal | undefined;
}>;

/** `null` is an invalid requested channel; `undefined` is intentionally unselected. */
function selectedAuthChannel(
  tool: CliToolId,
  authChannel: CliAuthChannelId | undefined,
): CliAuthChannel | undefined | null {
  if (authChannel === undefined) return undefined;
  return selectCliAuthChannel(tool, { channel: authChannel }) ?? null;
}

async function declaredReadinessEvidence({
  executable,
  neutralDir,
  tool,
  probe,
  authChannel,
  signal,
}: Readonly<{
  executable: CliExecutableIdentity;
  neutralDir: string;
  tool: CliToolId;
  probe: CliDeclaredProbeContract;
  authChannel: CliAuthChannel | undefined;
  signal: AbortSignal | undefined;
}>): Promise<CliReadinessProbeEvidence> {
  throwIfAborted(signal);
  const versionEnvironment = await probeEnvironment({
    executable,
    neutralDir,
    tool,
    channel: undefined,
  });
  const version = hasForbiddenProbeArgument(probe.version)
    ? { kind: 'not-run' as const }
    : versionOutcomeFromProbe({
        probe: probe.version,
        output: await runProbe({
          executable,
          command: probe.version,
          cwd: neutralDir,
          env: versionEnvironment.env,
          signal,
        }),
      });
  if ((await revalidateCliExecutableIdentity(executable)) !== 'match') {
    return { version: { kind: 'cancelled' }, auth: 'cancelled' };
  }
  if (authChannel === undefined) return { version, auth: 'not-selected' };
  const authProbe =
    probe.auth.kind === 'not-run' ||
    !declaredAuthProbeIsSafe({ tool, auth: probe.auth, version: probe.version })
      ? null
      : probe.auth;
  if (authProbe === null && authChannel.stateBridge !== 'host-cli-state') {
    return { version, auth: 'not-run' };
  }

  const authEnvironment = await probeEnvironment({
    executable,
    neutralDir,
    tool,
    channel: authChannel,
  });
  throwIfAborted(signal);
  // A session channel without a safe status command still carries a real
  // presence fact: bridged state exists or it does not. A stale file can
  // overstate a login; the tool's own error surfaces at run time. A keychain
  // credential leaves no such fact, and with nothing to ask, unknown is the
  // only truthful answer.
  if (authProbe === null) {
    if (authEnvironment.credential === 'unobservable') return { version, auth: 'unknown' };
    return { version, auth: authEnvironment.credential === 'present' ? 'verified' : 'missing' };
  }
  // A credential the staged child cannot read is a credential it does not have,
  // whatever the host holds. Running the tool's own status command here would
  // only re-observe that, at the cost of a subprocess. An unobservable one is
  // different: the status command below is the only thing that can see it.
  if (authEnvironment.credential === 'absent' && authChannelRequiresCredential(authChannel)) {
    return { version, auth: 'missing' };
  }
  const output = await runProbe({
    executable,
    command: authProbe,
    cwd: neutralDir,
    env: authEnvironment.env,
    signal,
  });
  if ((await revalidateCliExecutableIdentity(executable)) !== 'match') {
    return { version: { kind: 'cancelled' }, auth: 'cancelled' };
  }
  if (isProviderOracleProbe({ tool, command: authProbe })) {
    return {
      version,
      ...oracleAuthEvidence({
        output,
        presenceAvailable: authEnvironment.credential === 'present',
      }),
    };
  }
  return {
    version,
    auth: authFactFromDeclaredProbe({
      probe: authProbe,
      output,
      requiresCredential: authChannelRequiresCredential(authChannel),
    }),
  };
}

/** Runs only adapter-declared version and authentication status commands. */
export async function probeDeclaredCliReadinessEvidence(
  options: ProbeDeclaredCliReadinessEvidenceOptions,
): Promise<CliReadinessProbeEvidence> {
  throwIfAborted(options.signal);
  if (options.enabled === false || options.executable === null) {
    return { version: { kind: 'not-run' }, auth: 'not-run' };
  }
  if ((await revalidateCliExecutableIdentity(options.executable)) !== 'match') {
    return { version: { kind: 'cancelled' }, auth: 'cancelled' };
  }
  const selectedChannel = selectedAuthChannel(options.tool, options.authChannel);
  const authChannel = selectedChannel === null ? undefined : selectedChannel;
  const neutralDir = await mkdtemp(join(tmpdir(), 'splitbrief-readiness-'));
  try {
    return await declaredReadinessEvidence({
      executable: options.executable,
      neutralDir,
      tool: options.tool,
      probe: options.probe,
      authChannel,
      signal: options.signal,
    });
  } finally {
    await rm(neutralDir, { recursive: true, force: true });
  }
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
    ...(options.authChannel === undefined ? {} : { authChannel: options.authChannel }),
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
  let auth: CliAuthState;
  let providerAuth: CliProviderAuth | undefined;
  if (isDeclaredCliProbeContract(options.probe)) {
    const evidence = await probeDeclaredCliReadinessEvidence({
      tool: options.tool,
      executable: options.executable,
      probe: options.probe.declared,
      ...(options.authChannel !== undefined ? { authChannel: options.authChannel } : {}),
      enabled: base.enabled,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });
    installedVersion = evidence.version.kind === 'success' ? evidence.version.value : null;
    auth = legacyAuthState(evidence.auth);
    providerAuth = evidence.providerAuth;
  } else {
    const neutralDir = await mkdtemp(join(tmpdir(), 'splitbrief-readiness-'));
    try {
      const environment = await probeEnvironment({
        executable: options.executable,
        neutralDir,
        tool: options.tool,
        channel: undefined,
      });
      const versionProbe = await runProbe({
        executable: options.executable,
        command: options.probe.version,
        cwd: neutralDir,
        env: environment.env,
        signal: options.signal,
      });
      installedVersion = extractVersion(versionProbe);
      auth = 'unknown';
    } finally {
      await rm(neutralDir, { recursive: true, force: true });
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
      compatibility: 'unverified',
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

export function authChannelRequiresCredential(channel: CliAuthChannel): boolean {
  return channel.env.length > 0 || channel.stateBridge === 'host-cli-state';
}
