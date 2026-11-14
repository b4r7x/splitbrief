import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CliAuthState } from '../../../core/discovery/detection/tool.js';
import type { CliProviderAuth } from '../../../core/discovery/detection/auth.js';
import type { CliExecutableIdentity } from '../../../core/discovery/detection/executable.js';
import type { ProbeOutcome } from '../../../core/discovery/runner-evidence.js';
import { classifyCliAdmittedVersion } from '../../../core/runners/cli-tool/version.js';
import { CLI_TOOL_CATALOG, defaultCliAuthChannel } from '../../../core/runners/cli-tool/catalog.js';
import { cliAuthChannelPlatformSupported } from '../../../core/runners/cli-tool/auth-channels.js';
import type { CliToolId } from '../../../core/runners/cli-tool/types.js';
import type { CliReadinessResult } from '../../../core/schemas/readiness.js';
import { deriveCliReadiness } from '../../../core/readiness/cli-remediation.js';
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
  type CliAuthProbe,
  type CliDeclaredProbeContract,
  type CliProbeCommand,
  type CliProbeContract,
  type CliProbeOutput,
} from './contract.js';
import { isProviderOracleProbe, providerOracleCommand } from './provider-oracle.js';
import { trackProbe } from '../../probe-activity.js';
import { readCodexCredentialStore } from '../host-model-selection.js';
import { revalidateCliExecutableIdentity } from '../resolve-cli-executable.js';
import { removeSandboxTempDirs } from '../sandbox-state-paths.js';

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

export type ProbeDeclaredCliReadinessEvidenceOptions = Readonly<{
  tool: CliToolId;
  executable: CliExecutableIdentity | null;
  probe: CliDeclaredProbeContract;
  enabled?: boolean | undefined;
  signal?: AbortSignal | undefined;
  /** Receives the auth status run, so a catalog probe with the same argv can reuse its output. */
  onAuthProbeRun?: ((run: AuthProbeRun) => void) | undefined;
  versionProbes?: VersionProbeReads | undefined;
}>;

/**
 * One preparation's version checks, one per executable: every seat on the same executable shares
 * the first answer, so a version check that never answers costs one deadline, not one per seat.
 */
export type VersionProbeReads = Map<string, Promise<CliProbeOutput>>;

export type AuthProbeRun = Readonly<{ command: CliProbeCommand; output: CliProbeOutput }>;

/** A release below the probe's legacy threshold takes the legacy argv; an unread version takes the declared one. */
function authProbeCommandForVersion(
  tool: CliToolId,
  probe: Exclude<CliAuthProbe, { kind: 'not-run' }>,
  version: ProbeOutcome<string>,
): CliProbeCommand {
  if (probe.legacy === undefined || version.kind !== 'success') return probe;
  const below =
    classifyCliAdmittedVersion({
      installedVersion: version.value,
      minimumAdmittedVersion: probe.legacy.belowVersion,
      versionScheme: CLI_TOOL_CATALOG[tool].compatibility.versionScheme,
    }) === 'incompatible';
  return below ? { ...probe, command: probe.legacy.command } : probe;
}

// Codex keeps its session sign-in in the system keyring under the `keyring` store, and under
// `auto` when the host has a keyring; neither leaves the file a run reads.
async function absentCredentialAuth(tool: CliToolId): Promise<'keyring' | 'missing'> {
  if (tool !== 'codex') return 'missing';
  const store = await readCodexCredentialStore(process.env);
  return store === 'keyring' || store === 'auto' ? 'keyring' : 'missing';
}

async function declaredReadinessEvidence({
  executable,
  neutralDir,
  tool,
  probe,
  signal,
  onAuthProbeRun,
  versionProbes,
}: Readonly<{
  executable: CliExecutableIdentity;
  neutralDir: string;
  tool: CliToolId;
  probe: CliDeclaredProbeContract;
  signal: AbortSignal | undefined;
  onAuthProbeRun: ((run: AuthProbeRun) => void) | undefined;
  versionProbes: VersionProbeReads | undefined;
}>): Promise<CliReadinessProbeEvidence> {
  throwIfAborted(signal);
  const readVersion = (): Promise<CliProbeOutput> => {
    const { path, fingerprint } = executable;
    const key = `${tool}\u0000${path}\u0000${fingerprint.dev}:${fingerprint.ino}:${fingerprint.size}:${fingerprint.mtimeMs}`;
    const shared = versionProbes?.get(key);
    if (shared !== undefined) return shared;
    const read = probeEnvironment({ executable, neutralDir, tool, channel: undefined }).then(
      (environment) =>
        trackProbe({ tool, check: 'version' }, () =>
          runProbe({
            executable,
            command: probe.version,
            cwd: neutralDir,
            env: environment.env,
            signal,
          }),
        ),
    );
    versionProbes?.set(key, read);
    return read;
  };
  const version = hasForbiddenProbeArgument(probe.version)
    ? { kind: 'not-run' as const }
    : versionOutcomeFromProbe({ probe: probe.version, output: await readVersion() });
  if ((await revalidateCliExecutableIdentity(executable)) !== 'match') {
    return { version: { kind: 'cancelled' }, auth: 'cancelled' };
  }
  const authChannel = defaultCliAuthChannel(tool);
  if (!cliAuthChannelPlatformSupported(authChannel)) return { version, auth: 'policy-denied' };
  const authProbe =
    probe.auth.kind === 'not-run' ||
    !declaredAuthProbeIsSafe({ tool, auth: probe.auth, version: probe.version })
      ? null
      : probe.auth;
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
    return {
      version,
      auth:
        authEnvironment.credential === 'present' ? 'verified' : await absentCredentialAuth(tool),
    };
  }
  const oracleProbe = isProviderOracleProbe({ tool, command: authProbe });
  // A credential the staged child cannot read is a credential it does not have,
  // whatever the host holds, so a status command would only re-observe that. A
  // provider listing always runs: OpenCode 2 keeps its sign-ins in `opencode.db`,
  // which the presence check does not read, so only the listing can say. An
  // unobservable credential also goes to the status command below.
  if (!oracleProbe && authEnvironment.credential === 'absent') {
    return { version, auth: await absentCredentialAuth(tool) };
  }
  const authCommand = authProbeCommandForVersion(tool, authProbe, version);
  const output = await trackProbe({ tool, check: 'sign-in' }, () =>
    runProbe({
      executable,
      command: authCommand,
      cwd: neutralDir,
      env: authEnvironment.env,
      signal,
    }),
  );
  if ((await revalidateCliExecutableIdentity(executable)) !== 'match') {
    return { version: { kind: 'cancelled' }, auth: 'cancelled' };
  }
  onAuthProbeRun?.({ command: authCommand, output });
  if (oracleProbe) {
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
  const neutralDir = await mkdtemp(join(tmpdir(), 'splitbrief-readiness-'));
  try {
    return await declaredReadinessEvidence({
      executable: options.executable,
      neutralDir,
      tool: options.tool,
      probe: options.probe,
      signal: options.signal,
      onAuthProbeRun: options.onAuthProbeRun,
      versionProbes: options.versionProbes,
    });
  } finally {
    await rm(neutralDir, { recursive: true, force: true });
    removeSandboxTempDirs(neutralDir);
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
