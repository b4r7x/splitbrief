import type { ChildProcess } from 'node:child_process';
import type { Dirent } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import type { RunnerDiscoveryContext } from '../../core/config/accessors/runner-config.js';
import type {
  CliExecutableIdentity,
  CliExecutableReceipt,
  CliToolDetection,
  DetectedModel,
  ProviderDetection,
} from '../../core/discovery/detection.js';
import {
  CliExecutableReceiptSchema,
  ExecutableIdentitySchema,
} from '../../core/discovery/detection.js';
import type {
  AuthFact,
  CompatibilityFact,
  CredentialPresence,
  ExecutableFact,
  ProbeOutcome,
  RunnerEvidence,
} from '../../core/discovery/runner-evidence.js';
import {
  CLI_TOOL_CATALOG,
  CLI_TOOL_IDS,
  classifyCliAdmittedVersion,
  selectCliAuthChannel,
  type CliAuthChannel,
  type CliAuthChannelId,
  type CliCompatibility,
  type CliToolId,
  type RunnerRole,
} from '../../core/runners/cli-tool-catalog.js';
import type { CliReadinessResult } from '../../core/schemas/readiness.js';
import { cliReadinessCheckId, deriveCliReadiness } from '../../core/schemas/readiness.js';
import { createBoundedOutput, type BoundedOutput } from '../../lib/process/bounded-output.js';
import { killProcess } from '../../lib/process/registry.js';
import { matches } from '../../utils/error.js';
import { throwIfAborted } from '../../utils/abort.js';
import { assertNever, includes } from '../../utils/type-guards.js';
import {
  isFatalSignal,
  spawnPipe,
  type SpawnPipeFatalSignal,
} from '../../lib/process/spawn/lifecycle.js';
import { DISCOVERY_SUBPROCESS_TIMEOUT_MS } from '../constants.js';
import { detectAvailableProviders } from '../providers/registry.js';
import type { ConfiguredProviderOutcome } from './provider-outcomes.js';
import {
  resolveCliExecutable,
  resolveCliExecutableAliases,
  type CliExecutableResolver,
} from '../runners/resolve-cli-executable.js';
import { createSandboxEnv, prependCliExecutableDirectory } from '../runners/sandbox-env.js';
import {
  isCanonicalCliDeclaredProbe,
  lookupCliReadinessProbe,
} from '../runners/cli-tools/registry.js';
import {
  authChannelRequiresCredential,
  probeCliReadiness,
  probeDeclaredCliReadinessEvidence,
} from '../runners/cli-tools/readiness-probe.js';
import {
  isDeclaredCliProbeContract,
  type CliCatalogProbe,
  type CliDeclaredProbeContract,
  type CliProbeCommand,
  type CliProbeOutput,
} from '../runners/cli-tools/contract.js';
import { revalidateCliExecutableIdentity } from '../runners/cli-tools/process-invoke.js';

type ResolveCliExecutable = CliExecutableResolver;
type ProbeCliReadiness = typeof probeCliReadiness;
type ProbeDeclaredCliReadinessEvidence = typeof probeDeclaredCliReadinessEvidence;
type LookupCliReadinessProbe = typeof lookupCliReadinessProbe;
type CliRunnerDiscoveryContext = RunnerDiscoveryContext & Readonly<{ kind: 'cli'; id: CliToolId }>;

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
  probe: Exclude<CliCatalogProbe, { kind: 'not-run' }>;
  installedVersion: string;
  refresh: 'automatic' | 'manual';
  authChannel: CliAuthChannel | undefined;
  issuedAt: number;
}>;

type CatalogProbeEnvironment = Readonly<{
  env: NodeJS.ProcessEnv;
  authAvailable: boolean;
}>;

function snapshotCredentialDomain(
  credentialDomain: RunnerDiscoveryContext['credentialDomain'],
): RunnerDiscoveryContext['credentialDomain'] {
  if (credentialDomain === undefined) return undefined;
  const credentialSource =
    credentialDomain.credentialSource.kind === 'env'
      ? Object.freeze({
          kind: 'env' as const,
          name: credentialDomain.credentialSource.name,
        })
      : Object.freeze({
          kind: 'inline' as const,
          configNodeId: credentialDomain.credentialSource.configNodeId,
        });
  return Object.freeze({
    providerId: credentialDomain.providerId,
    endpointOrigin: credentialDomain.endpointOrigin,
    authChannel: credentialDomain.authChannel,
    credentialSource,
    configGeneration: credentialDomain.configGeneration,
  });
}

function snapshotCliContext(context: CliRunnerDiscoveryContext): CliRunnerDiscoveryContext {
  const credentialDomain = snapshotCredentialDomain(context.credentialDomain);
  return Object.freeze({
    role: context.role,
    kind: 'cli' as const,
    id: context.id,
    ...(context.model === undefined ? {} : { model: context.model }),
    ...(context.authChannel === undefined ? {} : { authChannel: context.authChannel }),
    ...(context.endpointOrigin === undefined ? {} : { endpointOrigin: context.endpointOrigin }),
    credentialPresent: context.credentialPresent,
    ...(credentialDomain === undefined ? {} : { credentialDomain }),
    configGeneration: context.configGeneration,
  });
}

function isCompleteCliContext(context: CliRunnerDiscoveryContext): boolean {
  if (
    (context.role !== 'planner' && context.role !== 'implementer') ||
    typeof context.configGeneration !== 'string' ||
    context.configGeneration.trim().length === 0 ||
    typeof context.credentialPresent !== 'boolean'
  ) {
    return false;
  }
  return context.credentialDomain === undefined;
}

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

function immutableCliExecutableReceipt(receipt: CliExecutableReceipt): CliExecutableReceipt {
  return Object.freeze({
    path: receipt.path,
    fingerprint: Object.freeze({ ...receipt.fingerprint }),
    executableIdentity: Object.freeze({ ...receipt.executableIdentity }),
  });
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

function richCliExecutable(executable: CliExecutableIdentity): CliExecutableReceipt | undefined {
  const result = CliExecutableReceiptSchema.safeParse(executable);
  return result.success ? result.data : undefined;
}

function immutableCliExecutableIdentity(executable: CliExecutableIdentity): CliExecutableIdentity {
  const receipt = richCliExecutable(executable);
  if (receipt !== undefined) return immutableCliExecutableReceipt(receipt);
  return Object.freeze({
    path: executable.path,
    fingerprint: Object.freeze({ ...executable.fingerprint }),
  });
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
    !isCompleteCliContext(input.context) ||
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
    }) !== 'compatible'
  ) {
    return undefined;
  }

  return Object.freeze({
    context: snapshotCliContext(input.context),
    executable: immutableCliExecutableReceipt(executable),
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

async function catalogProbeEnvironment(
  operation: AdmittedCatalogOperation,
  neutralDir: string,
): Promise<CatalogProbeEnvironment> {
  const channel = operation.authChannel;
  const env = await createSandboxEnv(
    neutralDir,
    [...(channel?.env ?? [])],
    channel?.stateBridge === 'host-cli-state' ? operation.context.id : undefined,
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
      PATH: prependCliExecutableDirectory({
        executablePath: operation.executable.path,
        safeRuntimePath: catalogRuntimePath(),
      }),
    },
    authAvailable,
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
  if (output.timedOut) return { kind: 'timeout' };
  if (output.outputExceeded || output.exitCode === null || output.exitCode !== 0) {
    return { kind: 'malformed' };
  }
  try {
    return probe.parse(output);
  } catch {
    return { kind: 'malformed' };
  }
}

async function probeContextCatalog(
  input: Readonly<{
    context: CliRunnerDiscoveryContext;
    executable: CliExecutableIdentity;
    probe: CliDeclaredProbeContract;
    version: ProbeOutcome<string>;
    refresh: 'automatic' | 'manual';
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
    }) !== 'compatible'
  ) {
    return { kind: 'unsupported' };
  }
  const probe = selectedCatalogProbe(operation.probe, operation.refresh);
  if ((await revalidateCliExecutableIdentity(operation.executable)) !== 'match') {
    return { kind: 'cancelled' };
  }
  const neutralDir = await mkdtemp(join(tmpdir(), 'splitbrief-catalog-'));
  try {
    const environment = await catalogProbeEnvironment(operation, neutralDir);
    throwIfAborted(input.signal);
    if (
      !environment.authAvailable &&
      operation.authChannel !== undefined &&
      authChannelRequiresCredential(operation.authChannel)
    ) {
      return { kind: 'missing-credential' };
    }
    const outcome = catalogOutcomeFromProbe(
      probe,
      await runAdmittedCatalogProbe(operation, probe, neutralDir, environment.env, input.signal),
    );
    return (await revalidateCliExecutableIdentity(operation.executable)) === 'match'
      ? outcome
      : { kind: 'cancelled' };
  } finally {
    await rm(neutralDir, { recursive: true, force: true });
  }
}

export interface DetectCliToolsOptions {
  projectDir?: string | undefined;
  /** Limit a live probe to the tools selected by a start configuration. */
  tools?: readonly CliToolId[] | undefined;
  role?: RunnerRole | undefined;
  /** Readiness-only resolver seam; this API cannot request native catalog work. */
  resolveExecutable?: ResolveCliExecutable | undefined;
  /** Readiness-only seam; native catalog work is not reachable through this API. */
  probeReadiness?: ProbeCliReadiness | undefined;
  /** Readiness-only declaration seam; native catalog work is not reachable through this API. */
  lookupProbe?: LookupCliReadinessProbe | undefined;
  authChannel?: CliAuthChannelId | undefined;
  authChannels?: Partial<Record<CliToolId, CliAuthChannelId | undefined>> | undefined;
  now?: (() => number) | undefined;
  signal?: AbortSignal | undefined;
}

export function cliDetectionFromReadiness(result: CliReadinessResult): CliToolDetection {
  const diagnostic =
    result.remediation === null
      ? { state: 'ready' as const, remediation: null }
      : { state: result.status, remediation: result.remediation };
  return {
    tool: result.tool,
    executable: result.executable,
    trust: result.trust,
    installedVersion: result.installedVersion,
    testedVersion: result.testedVersion,
    compatibility: result.compatibility,
    auth: result.auth,
    ...(result.providerAuth === undefined ? {} : { providerAuth: result.providerAuth }),
    diagnostic,
    probedAt: result.probedAt,
  };
}

type AuthChannelSelection =
  | Readonly<{ state: 'selected'; channel: CliAuthChannelId }>
  | Readonly<{ state: 'withheld' }>;

interface DetectCliToolDependencies {
  projectDir: string;
  resolveExecutable: ResolveCliExecutable;
  probeReadiness: ProbeCliReadiness;
  lookupProbe: LookupCliReadinessProbe;
  role: RunnerRole;
  authChannel: AuthChannelSelection;
  now: () => number;
  signal: AbortSignal | undefined;
}

function selectedAuthChannel(
  options: DetectCliToolsOptions,
  tool: CliToolId,
): AuthChannelSelection {
  if (options.authChannels && Object.hasOwn(options.authChannels, tool)) {
    const channel = options.authChannels[tool];
    return channel === undefined ? { state: 'withheld' } : { state: 'selected', channel };
  }
  if (options.authChannel !== undefined) {
    return { state: 'selected', channel: options.authChannel };
  }
  return { state: 'withheld' };
}

function unresolvedDetection(
  tool: CliToolId,
  probedAt: number,
  untrusted: boolean,
): CliToolDetection {
  const testedVersion = CLI_TOOL_CATALOG[tool].compatibility.testedVersion;
  if (untrusted) {
    return {
      tool,
      executable: null,
      trust: 'untrusted',
      installedVersion: null,
      testedVersion,
      compatibility: 'not-checked',
      auth: 'not-checked',
      diagnostic: {
        state: 'untrusted',
        remediation: `Trust the exact ${tool} executable identity, then run runner readiness again.`,
      },
      probedAt,
    };
  }

  return cliDetectionFromReadiness(
    deriveCliReadiness({
      tool,
      enabled: true,
      installation: 'unavailable',
      executable: null,
      trust: 'not-checked',
      installedVersion: null,
      testedVersion,
      compatibility: 'not-checked',
      auth: 'not-checked',
      probedAt,
    }),
  );
}

function unresolvedReadiness(
  tool: CliToolId,
  probedAt: number,
  untrusted: boolean,
): CliReadinessResult {
  const testedVersion = CLI_TOOL_CATALOG[tool].compatibility.testedVersion;
  if (untrusted) {
    // The resolver deliberately withholds the candidate path for an untrusted
    // executable. Preserve that distinction without fabricating an identity:
    // installation was observed, but no trusted executable can reach the gate.
    return {
      tool,
      enabled: true,
      installation: 'installed',
      executable: null,
      trust: 'untrusted',
      installedVersion: null,
      testedVersion,
      compatibility: 'not-checked',
      auth: 'not-checked',
      probedAt,
      checkId: cliReadinessCheckId(tool),
      status: 'untrusted',
      remediation: `Trust the exact ${tool} executable identity, then run runner readiness again.`,
    };
  }

  return deriveCliReadiness({
    tool,
    enabled: true,
    installation: 'unavailable',
    executable: null,
    trust: 'not-checked',
    installedVersion: null,
    testedVersion,
    compatibility: 'not-checked',
    auth: 'not-checked',
    probedAt,
  });
}

type CliReadinessProbeOutcome = Readonly<{
  readiness: CliReadinessResult;
  executableResolution: 'unavailable' | 'untrusted' | 'resolved';
}>;

async function detectCliToolReadiness(
  tool: CliToolId,
  options: DetectCliToolDependencies,
): Promise<CliReadinessProbeOutcome> {
  throwIfAborted(options.signal);
  const descriptor = CLI_TOOL_CATALOG[tool];
  let executable: Awaited<ReturnType<ResolveCliExecutable>>;
  try {
    executable = (
      await resolveCliExecutableAliases({
        commands: descriptor.executableAliases,
        projectDir: options.projectDir,
        resolveExecutable: options.resolveExecutable,
      })
    ).executable;
  } catch (cause) {
    const untrusted = matches('cli-executable-untrusted')(cause);
    const probedAt = options.now();
    return {
      executableResolution: untrusted ? 'untrusted' : 'unavailable',
      readiness: unresolvedReadiness(tool, probedAt, untrusted),
    };
  }
  throwIfAborted(options.signal);

  try {
    const selectedChannel =
      options.authChannel.state === 'withheld'
        ? undefined
        : selectCliAuthChannel(tool, { channel: options.authChannel.channel });
    const result = await options.probeReadiness({
      tool,
      executable,
      probe: options.lookupProbe({ tool, role: options.role }),
      authChannel: selectedChannel?.id,
      now: options.now,
      signal: options.signal,
      classifyVersion: ({ installedVersion }) =>
        classifyCliAdmittedVersion({
          installedVersion,
          minimumAdmittedVersion: descriptor.compatibility.minimumAdmittedVersion,
        }),
    });
    return {
      executableResolution: 'resolved',
      readiness: deriveCliReadiness({
        tool: result.tool,
        enabled: result.enabled,
        installation: result.installation,
        executable: result.executable,
        trust: result.trust,
        installedVersion: result.installedVersion,
        testedVersion: result.testedVersion,
        compatibility: result.compatibility,
        auth: selectedChannel === undefined ? 'unknown' : result.auth,
        ...(selectedChannel === undefined || result.providerAuth === undefined
          ? {}
          : { providerAuth: result.providerAuth }),
        probedAt: result.probedAt,
      }),
    };
  } catch {
    throwIfAborted(options.signal);
    return {
      executableResolution: 'resolved',
      readiness: deriveCliReadiness({
        tool,
        enabled: true,
        installation: 'installed',
        executable,
        trust: 'trusted',
        installedVersion: null,
        testedVersion: descriptor.compatibility.testedVersion,
        compatibility: 'unverified',
        auth: 'not-checked',
        probedAt: options.now(),
      }),
    };
  }
}

async function detectCliTool(
  tool: CliToolId,
  options: DetectCliToolDependencies,
): Promise<CliToolDetection> {
  const outcome = await detectCliToolReadiness(tool, options);
  if (outcome.executableResolution === 'untrusted') {
    return unresolvedDetection(tool, outcome.readiness.probedAt, true);
  }
  return cliDetectionFromReadiness(outcome.readiness);
}

/**
 * Run the canonical bounded CLI probes and retain their readiness facts for
 * the start gate. This deliberately bypasses the detection cache: a start
 * gate must be based on the executable identity and auth state observed for
 * this invocation, not a stale store snapshot.
 */
export async function detectAvailableCliReadiness(
  options: DetectCliToolsOptions = {},
): Promise<CliReadinessResult[]> {
  const dependencies = {
    projectDir: options.projectDir ?? process.cwd(),
    resolveExecutable: options.resolveExecutable ?? resolveCliExecutable,
    probeReadiness: options.probeReadiness ?? probeCliReadiness,
    lookupProbe: options.lookupProbe ?? lookupCliReadinessProbe,
    role: options.role ?? 'planner',
    now: options.now ?? Date.now,
    signal: options.signal,
  };
  const tools = options.tools ?? CLI_TOOL_IDS;
  return Promise.all(
    tools.map(async (tool) => {
      const outcome = await detectCliToolReadiness(tool, {
        ...dependencies,
        authChannel: selectedAuthChannel(options, tool),
      });
      return outcome.readiness;
    }),
  );
}

export async function detectAvailableCliTools(
  options: DetectCliToolsOptions = {},
): Promise<CliToolDetection[]> {
  const dependencies = {
    projectDir: options.projectDir ?? process.cwd(),
    resolveExecutable: options.resolveExecutable ?? resolveCliExecutable,
    probeReadiness: options.probeReadiness ?? probeCliReadiness,
    lookupProbe: options.lookupProbe ?? lookupCliReadinessProbe,
    role: options.role ?? 'planner',
    now: options.now ?? Date.now,
    signal: options.signal,
  };
  const tools = options.tools ?? CLI_TOOL_IDS;
  return Promise.all(
    tools.map((tool) =>
      detectCliTool(tool, {
        ...dependencies,
        authChannel: selectedAuthChannel(options, tool),
      }),
    ),
  );
}

type RunnerEvidenceBase = Pick<
  RunnerEvidence,
  'runner' | 'context' | 'endpoint' | 'catalog' | 'modelRun'
>;

export interface DetectRunnerEvidenceOptions {
  context: RunnerDiscoveryContext;
  projectDir?: string | undefined;
  /** A test resolver may select only a real receipt; catalog work revalidates it before every run. */
  resolveExecutable?: ResolveCliExecutable | undefined;
  /** Readiness-only test seam. It is ignored whenever catalog discovery is requested. */
  lookupProbe?: LookupCliReadinessProbe | undefined;
  /** Readiness-only test seam. It is ignored whenever catalog discovery is requested. */
  probeDeclaredReadiness?: ProbeDeclaredCliReadinessEvidence | undefined;
  includeCatalog?: boolean | undefined;
  catalogRefresh?: 'automatic' | 'manual' | undefined;
  /** Observation-only catalog attribution handoff; receives an immutable receipt snapshot. */
  onResolvedCliExecutable?: ((executable: CliExecutableIdentity) => void) | undefined;
  now?: (() => number) | undefined;
  signal?: AbortSignal | undefined;
}

/**
 * Binds evidence to one active selection without serializing credential values.
 * Start derives this from config instead of trusting a returned evidence key.
 */
export function runnerDiscoveryContextKey(context: RunnerDiscoveryContext): string {
  const credentialDomain = context.credentialDomain;
  const credentialDomainParts =
    credentialDomain === undefined
      ? ['credential-domain', 'absent']
      : [
          'credential-domain',
          'present',
          credentialDomain.providerId,
          credentialDomain.endpointOrigin,
          credentialDomain.authChannel,
          credentialDomain.credentialSource.kind,
          credentialDomain.credentialSource.kind === 'env'
            ? credentialDomain.credentialSource.name
            : credentialDomain.credentialSource.configNodeId,
          credentialDomain.configGeneration,
        ];
  return [
    'runner-evidence-v1',
    context.role,
    context.kind,
    context.id,
    context.model ?? 'unselected',
    context.authChannel ?? 'not-selected',
    context.endpointOrigin ?? 'none',
    context.credentialPresent ? 'credential-present' : 'credential-absent',
    ...credentialDomainParts,
    context.configGeneration,
  ]
    .map((part) => encodeURIComponent(part))
    .join('|');
}

function runnerEvidenceBase(
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

function isCliContext(context: RunnerDiscoveryContext): context is CliRunnerDiscoveryContext {
  return context.kind === 'cli' && includes(CLI_TOOL_IDS, context.id);
}

function nonCliRunnerEvidence(context: RunnerDiscoveryContext, observedAt: number): RunnerEvidence {
  const base = runnerEvidenceBase(context, observedAt);
  switch (context.kind) {
    case 'api':
    case 'agent-sdk':
      return {
        ...base,
        installation: 'not-applicable',
        executable: { kind: 'not-applicable' },
        compatibility: { kind: 'not-applicable' },
        credential: context.credentialPresent ? 'present' : 'absent',
        auth: context.credentialPresent ? 'unknown' : 'missing',
      };
    case 'shell':
    case 'agent':
      return {
        ...base,
        installation: 'not-applicable',
        executable: { kind: 'not-applicable' },
        compatibility: { kind: 'not-applicable' },
        credential: 'not-applicable',
        auth: 'not-required',
      };
    case 'cli':
      return {
        ...base,
        installation: 'unknown',
        executable: { kind: 'unknown' },
        compatibility: {
          kind: 'unknown',
          installedVersion: null,
          testedVersion: 'unknown',
        },
        credential: 'unknown',
        auth: context.authChannel === undefined ? 'not-selected' : 'unknown',
      };
    default:
      return assertNever(context.kind);
  }
}

function executableFactFromResolved(executable: CliExecutableIdentity): ExecutableFact {
  const attached = 'executableIdentity' in executable ? executable.executableIdentity : undefined;
  const result = ExecutableIdentitySchema.safeParse(attached);
  return result.success ? { kind: 'trusted', identity: result.data } : { kind: 'unknown' };
}

function compatibilityFromVersion(
  input: Readonly<{
    version: ProbeOutcome<string>;
    compatibility: CliCompatibility;
  }>,
): CompatibilityFact {
  const testedVersion = input.compatibility.testedVersion;
  if (input.version.kind !== 'success') {
    return { kind: 'unknown', installedVersion: null, testedVersion };
  }
  switch (
    classifyCliAdmittedVersion({
      installedVersion: input.version.value,
      minimumAdmittedVersion: input.compatibility.minimumAdmittedVersion,
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

function credentialFromCliAuth(
  context: RunnerDiscoveryContext,
  auth: AuthFact,
): CredentialPresence {
  if (context.credentialPresent) return 'present';
  switch (auth) {
    case 'missing':
      return 'absent';
    case 'verified':
    case 'invalid':
      return 'present';
    case 'not-required':
    case 'not-selected':
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

function modelRunFromCatalog(
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

function legacyAuthFact(auth: CliReadinessResult['auth']): AuthFact {
  switch (auth) {
    case 'authenticated':
      return 'unknown';
    case 'unauthenticated':
      return 'missing';
    case 'unknown':
      return 'unknown';
    case 'not-required':
      return 'not-required';
    case 'not-checked':
      return 'not-run';
    default:
      return assertNever(auth);
  }
}

function compatibilityFromLegacy(readiness: CliReadinessResult): CompatibilityFact {
  switch (readiness.compatibility) {
    case 'compatible':
    case 'incompatible':
      return readiness.installedVersion === null
        ? {
            kind: 'unknown',
            installedVersion: null,
            testedVersion: readiness.testedVersion,
          }
        : {
            kind: readiness.compatibility,
            installedVersion: readiness.installedVersion,
            testedVersion: readiness.testedVersion,
          };
    case 'unverified':
    case 'not-checked':
      return {
        kind: 'unknown',
        installedVersion: readiness.installedVersion,
        testedVersion: readiness.testedVersion,
      };
    default:
      return assertNever(readiness.compatibility);
  }
}

function executableFactFromLegacyReadiness(readiness: CliReadinessResult): ExecutableFact {
  if (readiness.trust === 'untrusted') return { kind: 'untrusted' };
  if (readiness.executable === null) {
    return readiness.installation === 'unavailable' ? { kind: 'missing' } : { kind: 'unknown' };
  }
  return readiness.trust === 'trusted'
    ? executableFactFromResolved(readiness.executable)
    : { kind: 'unknown' };
}

function evidenceFromLegacyReadiness(
  context: RunnerDiscoveryContext,
  observedAt: number,
  readiness: CliReadinessResult,
): RunnerEvidence {
  const base = runnerEvidenceBase(context, observedAt);
  const auth = legacyAuthFact(readiness.auth);
  return {
    ...base,
    installation: readiness.installation === 'installed' ? 'installed' : 'missing',
    executable: executableFactFromLegacyReadiness(readiness),
    compatibility: compatibilityFromLegacy(readiness),
    credential: credentialFromCliAuth(context, auth),
    auth,
  };
}

function unresolvedCliEvidence(
  context: CliRunnerDiscoveryContext,
  observedAt: number,
  cause: unknown,
): RunnerEvidence {
  const base = runnerEvidenceBase(context, observedAt);
  if (matches('cli-executable-untrusted')(cause)) {
    return {
      ...base,
      installation: 'installed',
      executable: { kind: 'untrusted' },
      compatibility: {
        kind: 'unknown',
        installedVersion: null,
        testedVersion: CLI_TOOL_CATALOG[context.id].compatibility.testedVersion,
      },
      credential: 'unknown',
      auth: context.authChannel === undefined ? 'not-selected' : 'not-run',
    };
  }
  if (matches('cli-executable-identity-drift')(cause)) {
    return {
      ...base,
      installation: 'installed',
      executable: { kind: 'identity-drifted' },
      compatibility: {
        kind: 'unknown',
        installedVersion: null,
        testedVersion: CLI_TOOL_CATALOG[context.id].compatibility.testedVersion,
      },
      credential: 'unknown',
      auth: 'cancelled',
    };
  }
  if (matches('cli-executable-unavailable')(cause)) {
    return {
      ...base,
      installation: 'missing',
      executable: { kind: 'missing' },
      compatibility: {
        kind: 'unknown',
        installedVersion: null,
        testedVersion: CLI_TOOL_CATALOG[context.id].compatibility.testedVersion,
      },
      credential: 'unknown',
      auth: context.authChannel === undefined ? 'not-selected' : 'not-run',
    };
  }
  return {
    ...base,
    installation: 'unknown',
    executable: { kind: 'unknown' },
    compatibility: {
      kind: 'unknown',
      installedVersion: null,
      testedVersion: CLI_TOOL_CATALOG[context.id].compatibility.testedVersion,
    },
    credential: 'unknown',
    auth: context.authChannel === undefined ? 'not-selected' : 'unknown',
  };
}

function probeFailureEvidence(
  context: CliRunnerDiscoveryContext,
  observedAt: number,
  executable: CliExecutableIdentity,
): RunnerEvidence {
  const base = runnerEvidenceBase(context, observedAt);
  return {
    ...base,
    installation: 'installed',
    executable: executableFactFromResolved(executable),
    compatibility: {
      kind: 'unknown',
      installedVersion: null,
      testedVersion: CLI_TOOL_CATALOG[context.id].compatibility.testedVersion,
    },
    credential: context.credentialPresent ? 'present' : 'unknown',
    auth: context.authChannel === undefined ? 'not-selected' : 'unknown',
  };
}

function unsupportedCatalogEvidence(
  context: CliRunnerDiscoveryContext,
  observedAt: number,
  executable: CliExecutableIdentity,
): RunnerEvidence {
  const base = runnerEvidenceBase(context, observedAt);
  return {
    ...base,
    installation: 'installed',
    executable: executableFactFromResolved(executable),
    compatibility: {
      kind: 'unknown',
      installedVersion: null,
      testedVersion: CLI_TOOL_CATALOG[context.id].compatibility.testedVersion,
    },
    credential: context.credentialPresent ? 'present' : 'unknown',
    auth: context.authChannel === undefined ? 'not-selected' : 'not-run',
    catalog: { kind: 'unsupported' },
  };
}

/**
 * Probes exactly one sanitized active-runner context. It never chooses an auth
 * channel, runs a catalog unless requested, or returns probe output.
 */
export async function detectRunnerEvidence(
  options: DetectRunnerEvidenceOptions,
): Promise<RunnerEvidence> {
  throwIfAborted(options.signal);
  const now = options.now ?? Date.now;
  const observedAt = now();
  if (!isCliContext(options.context)) return nonCliRunnerEvidence(options.context, observedAt);

  const context = snapshotCliContext(options.context);
  if (!isCompleteCliContext(context)) return nonCliRunnerEvidence(context, observedAt);
  const catalogRequested = options.includeCatalog === true;
  const resolveExecutable = options.resolveExecutable ?? resolveCliExecutable;
  let executable: CliExecutableIdentity;
  try {
    const resolvedExecutable = (
      await resolveCliExecutableAliases({
        commands: CLI_TOOL_CATALOG[context.id].executableAliases,
        projectDir: options.projectDir ?? process.cwd(),
        resolveExecutable,
      })
    ).executable;
    executable = immutableCliExecutableIdentity(resolvedExecutable);
  } catch (cause) {
    throwIfAborted(options.signal);
    return unresolvedCliEvidence(context, observedAt, cause);
  }
  options.onResolvedCliExecutable?.(executable);

  const probe = (
    catalogRequested ? lookupCliReadinessProbe : (options.lookupProbe ?? lookupCliReadinessProbe)
  )({
    tool: context.id,
    role: context.role,
  });
  if (
    catalogRequested &&
    (!isDeclaredCliProbeContract(probe) ||
      !isCanonicalCliDeclaredProbe({
        tool: context.id,
        role: context.role,
        probe: probe.declared,
      }))
  ) {
    return unsupportedCatalogEvidence(context, observedAt, executable);
  }
  if (!isDeclaredCliProbeContract(probe)) {
    try {
      const readiness = await probeCliReadiness({
        tool: context.id,
        executable,
        probe,
        ...(context.authChannel !== undefined ? { authChannel: context.authChannel } : {}),
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
        now: () => observedAt,
        classifyVersion: ({ installedVersion }) =>
          classifyCliAdmittedVersion({
            installedVersion,
            minimumAdmittedVersion:
              CLI_TOOL_CATALOG[context.id].compatibility.minimumAdmittedVersion,
          }),
      });
      return evidenceFromLegacyReadiness(context, observedAt, readiness);
    } catch {
      throwIfAborted(options.signal);
      return probeFailureEvidence(context, observedAt, executable);
    }
  }

  const declaredProbeOptions = {
    tool: context.id,
    executable,
    probe: probe.declared,
    ...(context.authChannel !== undefined ? { authChannel: context.authChannel } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  };
  const declaredReadiness = catalogRequested
    ? probeDeclaredCliReadinessEvidence
    : (options.probeDeclaredReadiness ?? probeDeclaredCliReadinessEvidence);
  let declaredEvidence: Awaited<ReturnType<ProbeDeclaredCliReadinessEvidence>>;
  try {
    declaredEvidence = await declaredReadiness(declaredProbeOptions);
  } catch {
    throwIfAborted(options.signal);
    return probeFailureEvidence(context, observedAt, executable);
  }

  if (declaredEvidence.version.kind === 'cancelled' || declaredEvidence.auth === 'cancelled') {
    const base = runnerEvidenceBase(context, observedAt);
    return {
      ...base,
      installation: 'installed',
      executable: { kind: 'identity-drifted' },
      compatibility: {
        kind: 'unknown',
        installedVersion: null,
        testedVersion: CLI_TOOL_CATALOG[context.id].compatibility.testedVersion,
      },
      credential: credentialFromCliAuth(context, declaredEvidence.auth),
      auth: declaredEvidence.auth,
    };
  }

  const executableFact = executableFactFromResolved(executable);
  const compatibility = compatibilityFromVersion({
    version: declaredEvidence.version,
    compatibility: CLI_TOOL_CATALOG[context.id].compatibility,
  });
  let catalog: ProbeOutcome<readonly DetectedModel[]>;
  if (!catalogRequested) {
    catalog = { kind: 'not-run' };
  } else if (executableFact.kind !== 'trusted' || compatibility.kind !== 'compatible') {
    catalog = { kind: 'unsupported' };
  } else {
    try {
      catalog = await probeContextCatalog({
        context,
        executable,
        probe: probe.declared,
        version: declaredEvidence.version,
        refresh: options.catalogRefresh ?? 'automatic',
        now,
        signal: options.signal,
      });
    } catch {
      throwIfAborted(options.signal);
      return probeFailureEvidence(context, observedAt, executable);
    }
  }
  const base = runnerEvidenceBase(context, observedAt);
  return {
    ...base,
    installation: 'installed',
    executable: executableFact,
    compatibility,
    credential: credentialFromCliAuth(context, declaredEvidence.auth),
    auth: declaredEvidence.auth,
    catalog,
    modelRun: modelRunFromCatalog(context, base, catalog),
  };
}

export interface DetectAllResult {
  providers: ProviderDetection[];
  cliTools: CliToolDetection[];
  /** Present only for configuration-scoped API catalog discovery. */
  configuredProviderOutcomes?: readonly ConfiguredProviderOutcome[] | undefined;
}

export interface DetectAllOptions {
  detectProviders?:
    | ((input: Readonly<{ signal?: AbortSignal | undefined }>) => Promise<ProviderDetection[]>)
    | undefined;
  /**
   * Probes only API connections selected by the active runner configuration.
   * When supplied, this is authoritative and the broad legacy provider scan is
   * deliberately not constructed.
   */
  detectConfiguredProviderOutcomes?:
    | ((
        input: Readonly<{ signal?: AbortSignal | undefined }>,
      ) => Promise<readonly ConfiguredProviderOutcome[]>)
    | undefined;
  detectCliTools?: ((input: DetectCliToolsOptions) => Promise<CliToolDetection[]>) | undefined;
  authChannel?: CliAuthChannelId | undefined;
  authChannels?: Partial<Record<CliToolId, CliAuthChannelId | undefined>> | undefined;
  signal?: AbortSignal | undefined;
}

export async function detectAll(options: DetectAllOptions = {}): Promise<DetectAllResult> {
  throwIfAborted(options.signal);
  const configuredProviderOutcomes = options.detectConfiguredProviderOutcomes;
  const [providers, cliTools, configured] = await Promise.all([
    configuredProviderOutcomes === undefined
      ? (options.detectProviders ?? detectAvailableProviders)({ signal: options.signal })
      : Promise.resolve([]),
    (options.detectCliTools ?? detectAvailableCliTools)({
      authChannel: options.authChannel,
      authChannels: options.authChannels,
      signal: options.signal,
    }),
    configuredProviderOutcomes === undefined
      ? Promise.resolve(undefined)
      : configuredProviderOutcomes({ signal: options.signal }),
  ]);
  throwIfAborted(options.signal);
  return {
    providers,
    cliTools,
    ...(configured === undefined ? {} : { configuredProviderOutcomes: configured }),
  };
}
