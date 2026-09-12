import type { ChildProcess } from 'node:child_process';
import { delimiter, dirname } from 'node:path';
import type { CliExecutableIdentity } from '../../../core/discovery/detection.js';
import {
  cliAuthChannelHostStateAccess,
  type CliAuthChannel,
  type CliToolId,
} from '../../../core/runners/cli-tool-catalog.js';
import { createBoundedOutput, type BoundedOutput } from '../../../lib/process/bounded-output.js';
import { killProcess } from '../../../lib/process/registry.js';
import {
  isFatalSignal,
  spawnPipe,
  type SpawnPipeFatalSignal,
} from '../../../lib/process/spawn/lifecycle.js';
import { throwIfAborted } from '../../../utils/abort.js';
import { DISCOVERY_SUBPROCESS_TIMEOUT_MS } from '../../constants.js';
import {
  cliAuthChannelEnvKeys,
  cliPackageCacheEnv,
  createSandboxEnv,
  prependCliExecutableDirectory,
} from '../sandbox-env.js';
import { bridgedCliStatePresent } from '../sandbox-state-bridge.js';
import type { CliAuthProbe, CliProbeCommand, CliProbeOutput, CliVersionProbe } from './contract.js';

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
  preserveEnvKeys: readonly string[],
): Promise<CredentialPresence> {
  if (channel === undefined) return 'absent';
  if (preserveEnvKeys.some((key) => (env[key] ?? '').trim().length > 0)) return 'present';
  switch (cliAuthChannelHostStateAccess(channel)) {
    case 'bridged-files':
      return (await bridgedCliStatePresent(env, tool)) ? 'present' : 'absent';
    case 'host-account':
      return 'unobservable';
    case 'none':
      return 'absent';
  }
}

export async function probeEnvironment({
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
  const preserveEnvKeys = cliAuthChannelEnvKeys(channel);
  const env = await createSandboxEnv({
    projectDir: neutralDir,
    preserveEnvKeys,
    selectedCli: hostState === 'none' ? undefined : tool,
    hostState,
  });
  return {
    env: {
      ...env,
      // The version probe names no auth channel, so `createSandboxEnv` is not
      // told which tool is about to run and cannot place the package cache
      // itself. Without it the version this probe reads is a different build's.
      ...cliPackageCacheEnv(tool),
      PATH: prependCliExecutableDirectory({
        executablePath: executable.path,
        safeRuntimePath: probeRuntimePath(),
      }),
    },
    credential: await credentialPresence(env, tool, channel, preserveEnvKeys),
  };
}

export async function runProbe({
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

export function hasForbiddenProbeArgument(command: CliProbeCommand): boolean {
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

export function declaredAuthProbeIsSafe({
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
