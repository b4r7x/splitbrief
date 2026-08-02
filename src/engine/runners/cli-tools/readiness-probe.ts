import type { ChildProcess } from 'node:child_process';
import type { Dirent } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { CliAuthState, CliExecutableIdentity } from '../../../core/discovery/detection.js';
import {
  CLI_TOOL_CATALOG,
  selectCliAuthChannel,
  type CliAuthChannel,
  type CliAuthChannelId,
  type CliToolId,
} from '../../../core/runners/cli-tool-catalog.js';
import { deriveCliReadiness, type CliReadinessResult } from '../../../core/schemas/readiness.js';
import { createBoundedOutput, type BoundedOutput } from '../../../lib/process/bounded-output.js';
import { killProcess } from '../../../lib/process/registry.js';
import {
  isFatalSignal,
  spawnPipe,
  type SpawnPipeFatalSignal,
} from '../../../lib/process/spawn/lifecycle.js';
import { createSandboxEnv } from '../sandbox-env.js';
import type { CliProbeCommand, CliProbeContract } from './contract.js';
import { revalidateCliExecutableIdentity } from './process-invoke.js';

const PROBE_TIMEOUT_CEILING_MS = 30_000;
const PROBE_OUTPUT_CEILING_BYTES = 64 * 1024;
const PROBE_TIMED_OUT = Symbol('splitbrief.probeTimedOut');
export interface ProbeCliReadinessOptions {
  tool: CliToolId;
  executable: CliExecutableIdentity | null;
  probe: CliProbeContract;
  authChannel?: CliAuthChannelId | undefined;
  enabled?: boolean | undefined;
  now?: (() => number) | undefined;
  classifyVersion?:
    | ((input: {
        installedVersion: string;
        testedVersion: string;
      }) => 'compatible' | 'incompatible' | 'unverified')
    | undefined;
  classifyAuth?:
    | ((input: { stdout: string; stderr: string; exitCode: number }) => CliAuthState)
    | undefined;
}

interface ProbeOutput {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  outputExceeded: boolean;
}

interface ProbeEnvironment {
  env: NodeJS.ProcessEnv;
  authAvailable: boolean;
}

async function containsRegularFile(root: string): Promise<boolean> {
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isFile()) return true;
    if (entry.isDirectory() && (await containsRegularFile(path))) return true;
  }
  return false;
}

async function probeEnvironment(
  executable: CliExecutableIdentity,
  neutralDir: string,
  tool: CliToolId,
  channel: CliAuthChannel | undefined,
): Promise<ProbeEnvironment> {
  const env = await createSandboxEnv(
    neutralDir,
    [...(channel?.env ?? [])],
    channel?.stateBridge === 'host-cli-state' ? tool : undefined,
  );
  let authAvailable = (channel?.env ?? []).some((key) => {
    const value = env[key];
    return value !== undefined && value.trim().length > 0;
  });
  if (channel?.stateBridge === 'host-cli-state') {
    const stateRoots = [env.HOME, env.XDG_CONFIG_HOME, env.XDG_DATA_HOME].filter(
      (root): root is string => root !== undefined,
    );
    for (const root of new Set(stateRoots)) {
      if (await containsRegularFile(root)) {
        authAvailable = true;
        break;
      }
    }
  }
  return {
    env: {
      ...env,
      PATH: dirname(executable.path),
    },
    authAvailable,
  };
}

async function runProbe(
  executable: CliExecutableIdentity,
  command: CliProbeCommand,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<ProbeOutput> {
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
  const captured = (exitCode: number | null, timedOut: boolean): ProbeOutput => ({
    stdout: stdout.snapshot().text,
    stderr: stderr.snapshot().text,
    exitCode,
    timedOut,
    outputExceeded,
  });

  try {
    return await spawnPipe<ProbeOutput>({
      command: executable.path,
      args,
      cwd,
      env,
      // The detached group is what lets a probe prove its descendants were
      // reaped; `spawnPipe` refuses to launch where that guarantee is absent.
      detached: true,
      ledger: false,
      signal: timeout.signal,
      partialStdoutMaxBytes: maxOutputBytes,
      partialStderrMaxBytes: maxOutputBytes,
      onSpawned: (proc) => {
        child = proc;
        // The probe budget covers the child's own run, not the spawn that
        // precedes it, so the clock starts once the child exists.
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
        // A probe leader may exit while a descendant it spawned still holds the
        // group, so reap the group before the readiness answer is returned.
        if (child !== undefined) await killProcess(child, { group: true });
        return captured(exitCode, false);
      },
    });
  } catch (cause) {
    if (cause === PROBE_TIMED_OUT) return captured(null, true);
    if (isFatalSignal(cause) && cause.state === 'output-budget-breach')
      return captured(null, false);
    // A child that never started is a probe answer, not a harness failure.
    if (cause === spawnFailure) return captured(null, false);
    throw cause;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function extractVersion(output: ProbeOutput): string | null {
  const match = `${output.stdout}\n${output.stderr}`.match(
    /(?:^|\s|v)(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?)(?:\s|$)/,
  );
  return match?.[1] ?? null;
}

function untrustedResult(
  base: Readonly<{
    tool: CliToolId;
    enabled: boolean;
    testedVersion: string;
    probedAt: number;
  }>,
  executable: CliExecutableIdentity,
  installedVersion: string | null,
): CliReadinessResult {
  return deriveCliReadiness({
    ...base,
    installation: 'installed',
    executable,
    trust: 'untrusted',
    installedVersion,
    compatibility: 'not-checked',
    auth: 'not-checked',
  });
}

export async function probeCliReadiness(
  options: ProbeCliReadinessOptions,
): Promise<CliReadinessResult> {
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
    return untrustedResult(base, options.executable, null);
  }

  const authChannel =
    options.authChannel === undefined
      ? undefined
      : selectCliAuthChannel(options.tool, { channel: options.authChannel });

  const neutralDir = await mkdtemp(join(tmpdir(), 'splitbrief-readiness-'));
  try {
    const probeEnvironmentResult = await probeEnvironment(
      options.executable,
      neutralDir,
      options.tool,
      authChannel,
    );
    const { env } = probeEnvironmentResult;
    const versionProbe = await runProbe(options.executable, options.probe.version, neutralDir, env);
    const installedVersion = extractVersion(versionProbe);
    if (
      versionProbe.exitCode !== 0 ||
      versionProbe.timedOut ||
      versionProbe.outputExceeded ||
      installedVersion === null
    ) {
      return deriveCliReadiness({
        ...base,
        installation: 'installed',
        executable: options.executable,
        trust: 'trusted',
        installedVersion,
        compatibility: 'unverified',
        auth: 'not-checked',
      });
    }
    if ((await revalidateCliExecutableIdentity(options.executable)) !== 'match') {
      return untrustedResult(base, options.executable, installedVersion);
    }
    const compatibility = options.classifyVersion
      ? options.classifyVersion({ installedVersion, testedVersion: base.testedVersion })
      : installedVersion === base.testedVersion
        ? 'compatible'
        : 'unverified';
    if (compatibility !== 'compatible') {
      return deriveCliReadiness({
        ...base,
        installation: 'installed',
        executable: options.executable,
        trust: 'trusted',
        installedVersion,
        compatibility,
        auth: 'not-checked',
      });
    }

    if (authChannel === undefined) {
      return deriveCliReadiness({
        ...base,
        installation: 'installed',
        executable: options.executable,
        trust: 'trusted',
        installedVersion,
        compatibility,
        auth: 'unknown',
      });
    }

    if (!probeEnvironmentResult.authAvailable && authChannelRequiresCredential(authChannel)) {
      return deriveCliReadiness({
        ...base,
        installation: 'installed',
        executable: options.executable,
        trust: 'trusted',
        installedVersion,
        compatibility,
        auth: 'unauthenticated',
      });
    }

    const authProbe = await runProbe(options.executable, options.probe.auth, neutralDir, env);
    if ((await revalidateCliExecutableIdentity(options.executable)) !== 'match') {
      return untrustedResult(base, options.executable, installedVersion);
    }
    const auth = authStateFromProbe(authProbe, authChannel, options.classifyAuth);
    return deriveCliReadiness({
      ...base,
      installation: 'installed',
      executable: options.executable,
      trust: 'trusted',
      installedVersion,
      compatibility,
      auth,
    });
  } finally {
    await rm(neutralDir, { recursive: true, force: true });
  }
}

export function authChannelRequiresCredential(channel: CliAuthChannel): boolean {
  return channel.env.length > 0 || channel.stateBridge === 'host-cli-state';
}

function authStateFromProbe(
  authProbe: ProbeOutput,
  channel: CliAuthChannel,
  classifyAuth:
    | ((input: { stdout: string; stderr: string; exitCode: number }) => CliAuthState)
    | undefined,
): CliAuthState {
  if (authProbe.timedOut || authProbe.outputExceeded || authProbe.exitCode === null) {
    return 'unknown';
  }
  if (authProbe.exitCode !== 0) return 'unauthenticated';
  if (!classifyAuth) return 'unknown';
  const classified = classifyAuth({
    stdout: authProbe.stdout,
    stderr: authProbe.stderr,
    exitCode: authProbe.exitCode,
  });
  return authChannelRequiresCredential(channel) && classified === 'not-required'
    ? 'unauthenticated'
    : classified;
}
