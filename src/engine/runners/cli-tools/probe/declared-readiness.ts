import type { CliExecutableIdentity } from '../../../../core/discovery/detection/executable.js';
import type { ProbeOutcome } from '../../../../core/discovery/runner-evidence.js';
import { cliAuthChannelPlatformSupported } from '../../../../core/runners/cli-tool/auth-channels.js';
import {
  CLI_TOOL_CATALOG,
  defaultCliAuthChannel,
} from '../../../../core/runners/cli-tool/catalog.js';
import type { CliToolId } from '../../../../core/runners/cli-tool/types.js';
import { classifyCliAdmittedVersion } from '../../../../core/runners/cli-tool/version.js';
import { throwIfAborted } from '../../../../utils/abort.js';
import { trackProbe } from '../../../probe-activity.js';
import { revalidateCliExecutableIdentity } from '../../cli-executable/identity.js';
import { readCodexCredentialStore } from '../../host-model-selection.js';
import type {
  CliDeclaredProbeContract,
  CliProbeOutput,
  CliProbeCommand,
  CliAuthProbe,
} from './contract.js';
import {
  type CliReadinessProbeEvidence,
  versionOutcomeFromProbe,
  oracleAuthEvidence,
  authFactFromDeclaredProbe,
} from './evidence.js';
import { probeEnvironment, runProbe } from './process.js';
import { isProviderOracleProbe } from './provider-oracle.js';
import { hasForbiddenProbeArgument, declaredAuthProbeIsSafe } from './safety.js';
import { withProbeStage } from './stage.js';

export type ProbeDeclaredCliReadinessEvidenceOptions = Readonly<{
  tool: CliToolId;
  executable: CliExecutableIdentity | null;
  probe: CliDeclaredProbeContract;
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
  const { executable } = options;
  if (executable === null) {
    return { version: { kind: 'not-run' }, auth: 'not-run' };
  }
  if ((await revalidateCliExecutableIdentity(executable)) !== 'match') {
    return { version: { kind: 'cancelled' }, auth: 'cancelled' };
  }
  return withProbeStage('splitbrief-readiness-', options.signal, (neutralDir, signal) =>
    declaredReadinessEvidence({
      executable,
      neutralDir,
      tool: options.tool,
      probe: options.probe,
      signal,
      onAuthProbeRun: options.onAuthProbeRun,
      versionProbes: options.versionProbes,
    }),
  );
}
