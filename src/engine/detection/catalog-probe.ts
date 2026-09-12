import type { ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import type {
  CliExecutableIdentity,
  CliExecutableReceipt,
  DetectedModel,
} from '../../core/discovery/detection.js';
import type { ProbeOutcome } from '../../core/discovery/runner-evidence.js';
import {
  CLI_TOOL_CATALOG,
  cliAuthChannelHostStateAccess,
  selectCliAuthChannel,
  type CliAuthChannel,
  type CliToolId,
} from '../../core/runners/cli-tool-catalog.js';
import { classifyCliAdmittedVersion } from '../../core/runners/cli-version.js';
import { createBoundedOutput, type BoundedOutput } from '../../lib/process/bounded-output.js';
import { killProcess } from '../../lib/process/registry.js';
import {
  isFatalSignal,
  spawnPipe,
  type SpawnPipeFatalSignal,
} from '../../lib/process/spawn/lifecycle.js';
import { DISCOVERY_SUBPROCESS_TIMEOUT_MS } from '../constants.js';
import { resolveCustomExecutable } from '../runners/resolve-cli-executable.js';
import {
  cliAuthChannelEnvKeys,
  createSandboxEnv,
  prependCliExecutableDirectory,
} from '../runners/sandbox-env.js';
import { bridgedCliStatePresent } from '../runners/sandbox-state-bridge.js';
import { authChannelRequiresCredential } from '../runners/cli-tools/readiness-probe.js';
import { isCanonicalCliDeclaredProbe } from '../runners/cli-tools/registry.js';
import { throwIfAborted } from '../../utils/abort.js';
import type {
  CliCatalogProbe,
  CliDeclaredProbeContract,
  CliProbeCommand,
  CliProbeOutput,
} from '../runners/cli-tools/contract.js';
import {
  detectionRuntimeNamespace,
  immutableCliExecutableReceipt,
  isCredentialFreeCliContext,
  richCliExecutable,
  snapshotCliContext,
  type CliRunnerDiscoveryContext,
} from './cli-context.js';

const CATALOG_ADMISSION_MAX_AGE_MS = 30_000;
const CATALOG_PROBE_TIMEOUT_CEILING_MS = DISCOVERY_SUBPROCESS_TIMEOUT_MS;
const CATALOG_PROBE_OUTPUT_CEILING_BYTES = 4 * 1024 * 1024;
const CATALOG_PROBE_TIMED_OUT = Symbol('splitbrief.catalogProbeTimedOut');
const FORBIDDEN_CATALOG_PROBE_ARGUMENTS = new Set([
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

type AdmittedCatalogOperation = Readonly<{
  context: CliRunnerDiscoveryContext;
  executable: CliExecutableReceipt;
  /**
   * The one identity/cache namespace detection, readiness, and dispatch share
   * (REQ-019, REQ-049): the digest-bound identity of the executable the probe
   * will actually run. A fake loader or a receipt from a different runtime
   * cannot produce this namespace, so the operation is never admitted.
   */
  runtimeNamespace: string;
  probe: Exclude<CliCatalogProbe, { kind: 'not-run' }>;
  installedVersion: string;
  refresh: 'automatic' | 'manual';
  authChannel: CliAuthChannel | undefined;
  issuedAt: number;
}>;

type CatalogProbeEnvironment = Readonly<{
  env: NodeJS.ProcessEnv;
  /**
   * False only when the staged environment can see that the credential is not
   * there. An OS keychain item is invisible from the environment either way, so
   * it stays true and the probe itself decides.
   */
  credentialMayBePresent: boolean;
}>;

function hasForbiddenCatalogArgument(command: CliProbeCommand): boolean {
  return command.command.slice(1).some((argument) => {
    const normalized = argument.toLowerCase();
    return (
      FORBIDDEN_CATALOG_PROBE_ARGUMENTS.has(normalized) ||
      FORBIDDEN_CATALOG_PROBE_ARGUMENTS.has(normalized.replace(/^--/, ''))
    );
  });
}

function probeCommandsMatch(left: CliProbeCommand, right: CliProbeCommand): boolean {
  return (
    left.command.length === right.command.length &&
    left.command.every((argument, index) => argument === right.command[index])
  );
}

function declaredCatalogProbeIsSafe(
  tool: CliToolId,
  catalog: CliCatalogProbe,
  version: CliProbeCommand,
): catalog is Exclude<CliCatalogProbe, { kind: 'not-run' }> {
  if (
    catalog.kind !== 'catalog' ||
    hasForbiddenCatalogArgument(catalog) ||
    probeCommandsMatch(catalog, version)
  ) {
    return false;
  }
  if (catalog.manualCommand === undefined) return true;
  if (tool !== 'opencode' && tool !== 'kilo-code') return false;
  return (
    catalog.manualCommand.length === catalog.command.length + 1 &&
    catalog.manualCommand
      .slice(0, -1)
      .every((argument, index) => argument === catalog.command[index]) &&
    catalog.manualCommand.at(-1) === '--refresh'
  );
}

function immutableProbeCommand(
  command: readonly [string, ...string[]],
): readonly [string, ...string[]] {
  const [first, ...rest] = command;
  return Object.freeze([first, ...rest]);
}

function immutableAuthChannel(channel: CliAuthChannel | undefined): CliAuthChannel | undefined {
  if (channel === undefined) return undefined;
  return Object.freeze({ ...channel, env: Object.freeze([...channel.env]) });
}

function immutableCatalogProbe(
  probe: Exclude<CliCatalogProbe, { kind: 'not-run' }>,
): Exclude<CliCatalogProbe, { kind: 'not-run' }> {
  return Object.freeze({
    ...probe,
    command: immutableProbeCommand(probe.command),
    parse: Object.freeze(probe.parse),
    ...(probe.manualCommand === undefined
      ? {}
      : { manualCommand: immutableProbeCommand(probe.manualCommand) }),
  });
}

function selectedCatalogProbe(
  probe: Exclude<CliCatalogProbe, { kind: 'not-run' }>,
  refresh: 'automatic' | 'manual',
): Exclude<CliCatalogProbe, { kind: 'not-run' }> {
  if (refresh !== 'manual' || probe.manualCommand === undefined) return probe;
  return Object.freeze({ ...probe, command: immutableProbeCommand(probe.manualCommand) });
}

function selectedCatalogAuthChannel(
  context: CliRunnerDiscoveryContext,
): CliAuthChannel | undefined | null {
  if (context.authChannel === undefined) return undefined;
  return selectCliAuthChannel(context.id, { channel: context.authChannel }) ?? null;
}

function admitCatalogOperation(
  input: Readonly<{
    context: CliRunnerDiscoveryContext;
    executable: CliExecutableIdentity;
    probe: CliDeclaredProbeContract;
    version: ProbeOutcome<string>;
    refresh: 'automatic' | 'manual';
    issuedAt: number;
  }>,
): AdmittedCatalogOperation | undefined {
  const executable = richCliExecutable(input.executable);
  const authChannel = selectedCatalogAuthChannel(input.context);
  if (
    executable === undefined ||
    authChannel === null ||
    input.version.kind !== 'success' ||
    !isCredentialFreeCliContext(input.context) ||
    !isCanonicalCliDeclaredProbe({
      tool: input.context.id,
      role: input.context.role,
      probe: input.probe,
    }) ||
    !declaredCatalogProbeIsSafe(input.context.id, input.probe.catalog, input.probe.version) ||
    classifyCliAdmittedVersion({
      installedVersion: input.version.value,
      minimumAdmittedVersion:
        CLI_TOOL_CATALOG[input.context.id].compatibility.minimumAdmittedVersion,
      versionScheme: CLI_TOOL_CATALOG[input.context.id].compatibility.versionScheme,
    }) !== 'compatible'
  ) {
    return undefined;
  }
  const runtimeNamespace = detectionRuntimeNamespace(executable);
  if (runtimeNamespace === undefined) return undefined;

  return Object.freeze({
    context: snapshotCliContext(input.context),
    executable: immutableCliExecutableReceipt(executable),
    runtimeNamespace,
    probe: immutableCatalogProbe(input.probe.catalog),
    installedVersion: input.version.value,
    refresh: input.refresh,
    authChannel: immutableAuthChannel(authChannel),
    issuedAt: input.issuedAt,
  });
}

function catalogOperationIsFresh(operation: AdmittedCatalogOperation, now: number): boolean {
  const age = now - operation.issuedAt;
  return Number.isFinite(age) && age >= 0 && age <= CATALOG_ADMISSION_MAX_AGE_MS;
}

function catalogRuntimePath(): string {
  const directories =
    process.platform === 'win32'
      ? [dirname(process.execPath)]
      : [dirname(process.execPath), '/usr/bin', '/bin'];
  return [...new Set(directories)].join(delimiter);
}

async function catalogProbeEnvironment(
  operation: AdmittedCatalogOperation,
  neutralDir: string,
): Promise<CatalogProbeEnvironment> {
  const channel = operation.authChannel;
  const hostState = channel === undefined ? 'none' : cliAuthChannelHostStateAccess(channel);
  const preserveEnvKeys = cliAuthChannelEnvKeys(channel);
  const env = await createSandboxEnv({
    projectDir: neutralDir,
    preserveEnvKeys,
    selectedCli: hostState === 'none' ? undefined : operation.context.id,
    hostState,
  });
  const credentialMayBePresent =
    hostState === 'host-account' ||
    preserveEnvKeys.some((key) => (env[key] ?? '').trim().length > 0) ||
    (hostState === 'bridged-files' && (await bridgedCliStatePresent(env, operation.context.id)));
  return {
    env: {
      ...env,
      PATH: prependCliExecutableDirectory({
        executablePath: operation.executable.path,
        safeRuntimePath: catalogRuntimePath(),
      }),
    },
    credentialMayBePresent,
  };
}

async function runAdmittedCatalogProbe(
  operation: AdmittedCatalogOperation,
  command: Exclude<CliCatalogProbe, { kind: 'not-run' }>,
  cwd: string,
  env: NodeJS.ProcessEnv,
  externalSignal: AbortSignal | undefined,
): Promise<CliProbeOutput> {
  throwIfAborted(externalSignal);
  const [, ...args] = command.command;
  const timeoutMs =
    Number.isFinite(command.timeoutMs) && command.timeoutMs > 0
      ? Math.min(command.timeoutMs, CATALOG_PROBE_TIMEOUT_CEILING_MS)
      : CATALOG_PROBE_TIMEOUT_CEILING_MS;
  const maxOutputBytes =
    Number.isSafeInteger(command.maxOutputBytes) && command.maxOutputBytes > 0
      ? Math.min(command.maxOutputBytes, CATALOG_PROBE_OUTPUT_CEILING_BYTES)
      : CATALOG_PROBE_OUTPUT_CEILING_BYTES;
  const stdout = createBoundedOutput({ maxBytes: maxOutputBytes, policy: 'prefix-tail' });
  const stderr = createBoundedOutput({ maxBytes: maxOutputBytes, policy: 'prefix-tail' });
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
      remediation: `Catalog probe exceeded its ${maxOutputBytes}-byte output budget.`,
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
      command: operation.executable.path,
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
        timer = setTimeout(() => timeout.abort(CATALOG_PROBE_TIMED_OUT), timeoutMs);
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
    if (cause === CATALOG_PROBE_TIMED_OUT) return captured(null, true);
    if (isFatalSignal(cause) && cause.state === 'output-budget-breach') {
      return captured(null, false);
    }
    if (cause === spawnFailure) return captured(null, false);
    throw cause;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function catalogOutcomeFromProbe(
  probe: Exclude<CliCatalogProbe, { kind: 'not-run' }>,
  output: CliProbeOutput,
): ProbeOutcome<readonly DetectedModel[]> {
  if (output.outputExceeded) return { kind: 'malformed' };
  if (output.timedOut) return { kind: 'timeout' };
  if (output.exitCode !== 0) return { kind: 'malformed' };
  try {
    return probe.parse(output);
  } catch {
    return { kind: 'malformed' };
  }
}

export async function probeContextCatalog(
  input: Readonly<{
    context: CliRunnerDiscoveryContext;
    executable: CliExecutableIdentity;
    probe: CliDeclaredProbeContract;
    version: ProbeOutcome<string>;
    refresh: 'automatic' | 'manual';
    projectDir: string;
    now: () => number;
    signal: AbortSignal | undefined;
  }>,
): Promise<ProbeOutcome<readonly DetectedModel[]>> {
  throwIfAborted(input.signal);
  const operation = admitCatalogOperation({
    context: input.context,
    executable: input.executable,
    probe: input.probe,
    version: input.version,
    refresh: input.refresh,
    issuedAt: input.now(),
  });
  if (operation === undefined) return { kind: 'unsupported' };
  if (
    !catalogOperationIsFresh(operation, input.now()) ||
    classifyCliAdmittedVersion({
      installedVersion: operation.installedVersion,
      minimumAdmittedVersion:
        CLI_TOOL_CATALOG[operation.context.id].compatibility.minimumAdmittedVersion,
      versionScheme: CLI_TOOL_CATALOG[operation.context.id].compatibility.versionScheme,
    }) !== 'compatible'
  ) {
    return { kind: 'unsupported' };
  }
  const probe = selectedCatalogProbe(operation.probe, operation.refresh);
  // Immediately before dispatch, re-read the runtime receipt from disk
  // (content digest included): the admitted identity/cache namespace must
  // still match the executable that will run, so a fake loader, a replaced
  // binary, or a different cache namespace fails closed with zero dispatch.
  const reRead = await resolveCustomExecutable({
    command: operation.executable.executableIdentity.canonicalPath,
    projectDir: input.projectDir,
    expected: operation.executable,
  });
  if (reRead.kind !== 'resolved') return { kind: 'cancelled' };
  const neutralDir = await mkdtemp(join(tmpdir(), 'splitbrief-catalog-'));
  try {
    const environment = await catalogProbeEnvironment(operation, neutralDir);
    throwIfAborted(input.signal);
    if (
      !environment.credentialMayBePresent &&
      operation.authChannel !== undefined &&
      authChannelRequiresCredential(operation.authChannel)
    ) {
      return { kind: 'missing-credential' };
    }
    const outcome = catalogOutcomeFromProbe(
      probe,
      await runAdmittedCatalogProbe(operation, probe, neutralDir, environment.env, input.signal),
    );
    const after = await resolveCustomExecutable({
      command: operation.executable.executableIdentity.canonicalPath,
      projectDir: input.projectDir,
      expected: operation.executable,
    });
    return after.kind === 'resolved' ? outcome : { kind: 'cancelled' };
  } finally {
    await rm(neutralDir, { recursive: true, force: true });
  }
}
