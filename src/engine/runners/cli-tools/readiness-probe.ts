import type { ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import type {
  CliAuthState,
  CliExecutableIdentity,
  CliProviderAuthFact,
} from '../../../core/discovery/detection.js';
import type { AuthFact, ProbeOutcome } from '../../../core/discovery/runner-evidence.js';
import {
  CLI_TOOL_CATALOG,
  cliAuthChannelHostStateAccess,
  selectCliAuthChannel,
  type CliAuthChannel,
  type CliAuthChannelId,
  type CliToolId,
} from '../../../core/runners/cli-tool-catalog.js';
import { deriveCliReadiness, type CliReadinessResult } from '../../../core/schemas/readiness.js';
import { createBoundedOutput, type BoundedOutput } from '../../../lib/process/bounded-output.js';
import { killProcess } from '../../../lib/process/registry.js';
import { throwIfAborted } from '../../../utils/abort.js';
import {
  isFatalSignal,
  spawnPipe,
  type SpawnPipeFatalSignal,
} from '../../../lib/process/spawn/lifecycle.js';
import { DISCOVERY_SUBPROCESS_TIMEOUT_MS } from '../../constants.js';
import {
  bridgedCliStatePresent,
  createSandboxEnv,
  prependCliExecutableDirectory,
} from '../sandbox-env.js';
import {
  isDeclaredCliProbeContract,
  type CliAuthProbe,
  type CliDeclaredProbeContract,
  type CliProbeCommand,
  type CliProbeContract,
  type CliProbeOutput,
  type CliVersionProbe,
} from './contract.js';
import { isProviderOracleProbe, parseProviderOracleOutput } from './provider-oracle.js';
import { revalidateCliExecutableIdentity } from './process-invoke.js';

const PROBE_TIMEOUT_CEILING_MS = DISCOVERY_SUBPROCESS_TIMEOUT_MS;
const PROBE_OUTPUT_CEILING_BYTES = 64 * 1024;
const PROBE_TIMED_OUT = Symbol('splitbrief.probeTimedOut');
const FORBIDDEN_PROBE_ARGUMENTS = new Set([
  'download',
  'exec',
  'install',
  'login',
  'pull',
  'refresh',
  'run',
  'sync',
  'update',
  'upgrade',
]);

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
  /**
   * @deprecated Legacy command callbacks cannot establish authentication.
   * Adapter-declared `auth-status` probes expose a parser and are required
   * for a verified authentication fact.
   */
  classifyAuth?:
    | ((input: { stdout: string; stderr: string; exitCode: number }) => CliAuthState)
    | undefined;
}

export type CliReadinessProbeEvidence = Readonly<{
  version: ProbeOutcome<string>;
  auth: AuthFact;
  /** Per-provider facts; present only when a credential oracle ran cleanly and verified. */
  providerAuth?: readonly CliProviderAuthFact[] | undefined;
}>;

export type ProbeDeclaredCliReadinessEvidenceOptions = Readonly<{
  tool: CliToolId;
  executable: CliExecutableIdentity | null;
  probe: CliDeclaredProbeContract;
  authChannel?: CliAuthChannelId | undefined;
  enabled?: boolean | undefined;
  signal?: AbortSignal | undefined;
}>;

/**
 * What the staged environment itself says about the channel's credential.
 * `unobservable` is the honest answer for an OS keychain item: it leaves no
 * trace in the environment or in the sandbox roots, so only the tool's own
 * status command can settle it.
 */
type CredentialPresence = 'present' | 'absent' | 'unobservable';

interface ProbeEnvironment {
  env: NodeJS.ProcessEnv;
  credential: CredentialPresence;
}

/**
 * Declared readiness probes execute an exact resolved binary. Their PATH is
 * only an interpreter runtime aid, never a second executable-selection
 * channel, so ambient PATH entries (including external shadows) stay out.
 */
function probeRuntimePath(): string {
  const directories =
    process.platform === 'win32'
      ? [dirname(process.execPath)]
      : [dirname(process.execPath), '/usr/bin', '/bin'];
  return [...new Set(directories)].join(delimiter);
}

async function credentialPresence(
  env: NodeJS.ProcessEnv,
  tool: CliToolId,
  channel: CliAuthChannel | undefined,
): Promise<CredentialPresence> {
  if (channel === undefined) return 'absent';
  if (channel.env.some((key) => (env[key] ?? '').trim().length > 0)) return 'present';
  switch (cliAuthChannelHostStateAccess(channel)) {
    case 'bridged-files':
      return (await bridgedCliStatePresent(env, tool)) ? 'present' : 'absent';
    case 'host-account':
      return 'unobservable';
    case 'none':
      return 'absent';
  }
}

async function probeEnvironment({
  executable,
  neutralDir,
  tool,
  channel,
}: Readonly<{
  executable: CliExecutableIdentity;
  neutralDir: string;
  tool: CliToolId;
  channel: CliAuthChannel | undefined;
}>): Promise<ProbeEnvironment> {
  const hostState = channel === undefined ? 'none' : cliAuthChannelHostStateAccess(channel);
  const env = await createSandboxEnv(
    neutralDir,
    [...(channel?.env ?? [])],
    hostState === 'none' ? undefined : tool,
    hostState,
  );
  return {
    env: {
      ...env,
      PATH: prependCliExecutableDirectory({
        executablePath: executable.path,
        safeRuntimePath: probeRuntimePath(),
      }),
    },
    credential: await credentialPresence(env, tool, channel),
  };
}

async function runProbe({
  executable,
  command,
  cwd,
  env,
  signal: externalSignal,
}: Readonly<{
  executable: CliExecutableIdentity;
  command: CliProbeCommand;
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal | undefined;
}>): Promise<CliProbeOutput> {
  throwIfAborted(externalSignal);
  const [, ...args] = command.command;
  const timeoutMs =
    Number.isFinite(command.timeoutMs) && command.timeoutMs > 0
      ? Math.min(command.timeoutMs, PROBE_TIMEOUT_CEILING_MS)
      : PROBE_TIMEOUT_CEILING_MS;
  const maxOutputBytes =
    Number.isSafeInteger(command.maxOutputBytes) && command.maxOutputBytes > 0
      ? Math.min(command.maxOutputBytes, PROBE_OUTPUT_CEILING_BYTES)
      : PROBE_OUTPUT_CEILING_BYTES;
  const stdout = createBoundedOutput({ maxBytes: maxOutputBytes, policy: 'tail' });
  const stderr = createBoundedOutput({ maxBytes: maxOutputBytes, policy: 'tail' });
  const timeout = new AbortController();
  const signal =
    externalSignal === undefined
      ? timeout.signal
      : AbortSignal.any([externalSignal, timeout.signal]);
  let timer: NodeJS.Timeout | undefined;
  let child: ChildProcess | undefined;
  let spawnFailure: unknown;
  let outputBytes = 0;
  let outputExceeded = false;

  const collect = (output: BoundedOutput, chunk: string): SpawnPipeFatalSignal | undefined => {
    output.append(chunk);
    outputBytes += Buffer.byteLength(chunk, 'utf8');
    if (outputBytes <= maxOutputBytes || outputExceeded) return undefined;
    outputExceeded = true;
    return {
      state: 'output-budget-breach',
      remediation: `Readiness probe exceeded its ${maxOutputBytes}-byte output budget.`,
    };
  };
  const captured = (exitCode: number | null, timedOut: boolean): CliProbeOutput => ({
    stdout: stdout.snapshot().text,
    stderr: stderr.snapshot().text,
    exitCode,
    timedOut,
    outputExceeded,
  });

  try {
    return await spawnPipe<CliProbeOutput>({
      command: executable.path,
      args,
      cwd,
      env,
      detached: true,
      ledger: false,
      signal,
      partialStdoutMaxBytes: maxOutputBytes,
      partialStderrMaxBytes: maxOutputBytes,
      onSpawned: (proc) => {
        child = proc;
        timer = setTimeout(() => timeout.abort(PROBE_TIMED_OUT), timeoutMs);
        timer.unref?.();
      },
      onStdout: (chunk) => collect(stdout, chunk),
      onStderr: (chunk) => collect(stderr, chunk),
      onError: (err) => {
        spawnFailure = err;
        return null;
      },
      onClose: async (exitCode) => {
        if (child !== undefined) await killProcess(child, { group: true });
        return captured(exitCode, false);
      },
    });
  } catch (cause) {
    if (cause === PROBE_TIMED_OUT) return captured(null, true);
    if (isFatalSignal(cause) && cause.state === 'output-budget-breach') {
      return captured(null, false);
    }
    if (cause === spawnFailure) return captured(null, false);
    throw cause;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function hasForbiddenProbeArgument(command: CliProbeCommand): boolean {
  return command.command.slice(1).some((argument) => {
    const normalized = argument.toLowerCase();
    return (
      FORBIDDEN_PROBE_ARGUMENTS.has(normalized) ||
      FORBIDDEN_PROBE_ARGUMENTS.has(normalized.replace(/^--/, ''))
    );
  });
}

/**
 * `codex login status` is a documented read-only status command. Keep this
 * exception exact: an alias, flag, extra argument, or another tool continues
 * through the mutating-command denylist.
 */
function isExactCodexLoginStatusProbe({
  tool,
  command,
}: Readonly<{
  tool: CliToolId;
  command: CliProbeCommand;
}>): boolean {
  return (
    tool === 'codex' &&
    command.command.length === 3 &&
    command.command[0] === 'codex' &&
    command.command[1] === 'login' &&
    command.command[2] === 'status'
  );
}

function probeCommandsMatch({
  left,
  right,
}: Readonly<{
  left: CliProbeCommand;
  right: CliProbeCommand;
}>): boolean {
  return (
    left.command.length === right.command.length &&
    left.command.every((argument, index) => argument === right.command[index])
  );
}

function declaredAuthProbeIsSafe({
  tool,
  auth,
  version,
}: Readonly<{
  tool: CliToolId;
  auth: CliAuthProbe;
  version: CliVersionProbe;
}>): boolean {
  if (auth.kind === 'not-run') return false;
  if (hasForbiddenProbeArgument(auth) && !isExactCodexLoginStatusProbe({ tool, command: auth })) {
    return false;
  }
  if (probeCommandsMatch({ left: auth, right: version })) return false;
  return !auth.command
    .slice(1)
    .some((argument) => argument === '--version' || argument === 'version');
}

/** `null` is an invalid requested channel; `undefined` is intentionally unselected. */
function selectedAuthChannel(
  tool: CliToolId,
  authChannel: CliAuthChannelId | undefined,
): CliAuthChannel | undefined | null {
  if (authChannel === undefined) return undefined;
  return selectCliAuthChannel(tool, { channel: authChannel }) ?? null;
}

function versionOutcomeFromProbe({
  probe,
  output,
}: Readonly<{
  probe: CliVersionProbe;
  output: CliProbeOutput;
}>): ProbeOutcome<string> {
  if (output.timedOut) return { kind: 'timeout' };
  if (output.outputExceeded || output.exitCode === null || output.exitCode !== 0) {
    return { kind: 'malformed' };
  }
  try {
    const outcome = probe.parse(output);
    return outcome.kind === 'success' && outcome.value.trim().length === 0
      ? { kind: 'malformed' }
      : outcome;
  } catch {
    return { kind: 'malformed' };
  }
}

function authFactFromDeclaredProbe({
  probe,
  output,
  channel,
}: Readonly<{
  probe: Exclude<CliAuthProbe, { kind: 'not-run' }>;
  output: CliProbeOutput;
  channel: CliAuthChannel;
}>): AuthFact {
  if (output.timedOut) return 'timeout';
  if (output.outputExceeded) return 'malformed';
  if (output.exitCode === null) return 'unknown';
  try {
    const auth = probe.parse(output);
    if (auth === 'verified' && output.exitCode !== 0) return 'unknown';
    if (auth === 'not-required' && authChannelRequiresCredential(channel)) return 'unknown';
    return auth;
  } catch {
    return 'malformed';
  }
}

/**
 * Three-way oracle semantics. A listing that parsed cleanly is a probe that
 * ran and always wins: at least one entry verifies with per-provider facts,
 * and a clean zero is a truthful negative, never a presence fallback. Output
 * the oracle could not produce (nonzero exit, timeout, budget breach) or that
 * cannot be parsed falls back to bridged-state presence, so detection is
 * never worse than presence alone.
 */
function oracleAuthEvidence({
  output,
  presenceAvailable,
}: Readonly<{ output: CliProbeOutput; presenceAvailable: boolean }>): Pick<
  CliReadinessProbeEvidence,
  'auth' | 'providerAuth'
> {
  const fallback = { auth: presenceAvailable ? ('verified' as const) : ('missing' as const) };
  if (output.timedOut || output.outputExceeded || output.exitCode !== 0) return fallback;
  const parsed = parseProviderOracleOutput(output.stdout);
  if (parsed.kind !== 'success') return fallback;
  if (parsed.entries.length === 0) return { auth: 'missing' };
  return { auth: 'verified', providerAuth: parsed.entries };
}

function legacyAuthState(auth: AuthFact): CliAuthState {
  switch (auth) {
    case 'verified':
      return 'authenticated';
    case 'missing':
      return 'unauthenticated';
    case 'not-required':
      return 'not-required';
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
  }
}

function extractVersion(output: CliProbeOutput): string | null {
  const match = `${output.stdout}\n${output.stderr}`.match(
    /(?:^|\s|v)(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?)(?:\s|$)/,
  );
  return match?.[1] ?? null;
}

function untrustedResult({
  base,
  executable,
  installedVersion,
}: Readonly<{
  base: Readonly<{
    tool: CliToolId;
    enabled: boolean;
    testedVersion: string;
    probedAt: number;
    authChannel?: CliAuthChannelId | undefined;
  }>;
  executable: CliExecutableIdentity;
  installedVersion: string | null;
}>): CliReadinessResult {
  return deriveCliReadiness({
    ...base,
    installation: 'installed',
    executable: readinessExecutable(executable),
    trust: 'untrusted',
    installedVersion,
    compatibility: 'not-checked',
    auth: 'not-checked',
  });
}

function readinessExecutable(executable: CliExecutableIdentity): CliExecutableIdentity {
  return {
    path: executable.path,
    fingerprint: {
      dev: executable.fingerprint.dev,
      ino: executable.fingerprint.ino,
      size: executable.fingerprint.size,
      mtimeMs: executable.fingerprint.mtimeMs,
    },
  };
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
    auth: authFactFromDeclaredProbe({ probe: authProbe, output, channel: authChannel }),
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
  let providerAuth: readonly CliProviderAuthFact[] | undefined;
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
  if (installedVersion === null) {
    return deriveCliReadiness({
      ...base,
      installation: 'installed',
      executable: readinessExecutable(options.executable),
      trust: 'trusted',
      installedVersion,
      compatibility: 'unverified',
      auth,
      ...(providerAuth === undefined ? {} : { providerAuth }),
    });
  }
  const compatibility = options.classifyVersion
    ? options.classifyVersion({ installedVersion, testedVersion: base.testedVersion })
    : installedVersion === base.testedVersion
      ? 'compatible'
      : 'unverified';
  return deriveCliReadiness({
    ...base,
    installation: 'installed',
    executable: readinessExecutable(options.executable),
    trust: 'trusted',
    installedVersion,
    compatibility,
    auth: compatibility === 'compatible' ? auth : 'not-checked',
    ...(compatibility === 'compatible' && providerAuth !== undefined ? { providerAuth } : {}),
  });
}

export function authChannelRequiresCredential(channel: CliAuthChannel): boolean {
  return channel.env.length > 0 || channel.stateBridge === 'host-cli-state';
}
