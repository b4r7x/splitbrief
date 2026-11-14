import { delimiter, dirname } from 'node:path';
import type {
  CliExecutableIdentity,
  CliExecutableReceipt,
} from '../../../core/discovery/detection/executable.js';
import type { ProbeOutcome } from '../../../core/discovery/runner-evidence.js';
import type { CliAuthChannel } from '../../../core/runners/cli-tool/auth-channels.js';
import { CLI_TOOL_CATALOG, defaultCliAuthChannel } from '../../../core/runners/cli-tool/catalog.js';
import type { CliToolId } from '../../../core/runners/cli-tool/types.js';
import { classifyCliAdmittedVersion } from '../../../core/runners/cli-tool/version.js';
import type {
  CliCatalogProbe,
  CliCatalogProbeLegacy,
  CliDeclaredProbeContract,
  CliProbeCommand,
} from '../../runners/cli-tools/probe/contract.js';
import { isCanonicalCliDeclaredProbe } from '../../runners/cli-tools/registry.js';
import {
  detectionRuntimeNamespace,
  immutableCliExecutableReceipt,
  isCredentialFreeCliContext,
  richCliExecutable,
  snapshotCliContext,
  type CliRunnerDiscoveryContext,
} from '../cli-context.js';

const CATALOG_ADMISSION_MAX_AGE_MS = 30_000;
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

export type AdmittedCatalogOperation = Readonly<{
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
  authChannel: CliAuthChannel;
  issuedAt: number;
}>;

function hasForbiddenCatalogArgument(command: Readonly<{ command: readonly string[] }>): boolean {
  return command.command.slice(1).some((argument) => {
    const normalized = argument.toLowerCase();
    return (
      FORBIDDEN_CATALOG_PROBE_ARGUMENTS.has(normalized) ||
      FORBIDDEN_CATALOG_PROBE_ARGUMENTS.has(normalized.replace(/^--/, ''))
    );
  });
}

export function probeCommandsMatch(left: CliProbeCommand, right: CliProbeCommand): boolean {
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
  if (catalog.legacy !== undefined && !legacyCatalogProbeIsSafe(tool, catalog.legacy)) {
    return false;
  }
  if (catalog.manualCommand === undefined) return true;
  if (tool !== 'opencode' && tool !== 'kilo-code') return false;
  return refreshOnlyManualCommand(catalog.command, catalog.manualCommand);
}

function refreshOnlyManualCommand(
  command: readonly string[],
  manualCommand: readonly string[],
): boolean {
  return (
    manualCommand.length === command.length + 1 &&
    manualCommand.slice(0, -1).every((argument, index) => argument === command[index]) &&
    manualCommand.at(-1) === '--refresh'
  );
}

/** The legacy argv is fixed declaration too, so it answers to the same two rules. */
function legacyCatalogProbeIsSafe(tool: CliToolId, legacy: CliCatalogProbeLegacy): boolean {
  if (hasForbiddenCatalogArgument({ command: legacy.command })) return false;
  if (legacy.manualCommand === undefined) return true;
  if (tool !== 'opencode' && tool !== 'kilo-code') return false;
  return refreshOnlyManualCommand(legacy.command, legacy.manualCommand);
}

function immutableProbeCommand(
  command: readonly [string, ...string[]],
): readonly [string, ...string[]] {
  const [first, ...rest] = command;
  return Object.freeze([first, ...rest]);
}

function immutableAuthChannel(channel: CliAuthChannel): CliAuthChannel {
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

/** A release below the probe's legacy threshold takes the legacy listing; an unread version takes the declared one. */
export function catalogProbeForVersion(
  tool: CliToolId,
  probe: Exclude<CliCatalogProbe, { kind: 'not-run' }>,
  installedVersion: string,
): Exclude<CliCatalogProbe, { kind: 'not-run' }> {
  const legacy = probe.legacy;
  if (legacy === undefined) return probe;
  const below =
    classifyCliAdmittedVersion({
      installedVersion,
      minimumAdmittedVersion: legacy.belowVersion,
      versionScheme: CLI_TOOL_CATALOG[tool].compatibility.versionScheme,
    }) === 'incompatible';
  if (!below) return probe;
  // The legacy listing is one the sandbox already served, so the directory
  // header the newer server needs is dropped rather than carried down.
  return Object.freeze({
    kind: 'catalog',
    command: immutableProbeCommand(legacy.command),
    cwd: probe.cwd,
    maxOutputBytes: probe.maxOutputBytes,
    ...(legacy.manualCommand === undefined
      ? {}
      : { manualCommand: immutableProbeCommand(legacy.manualCommand) }),
    parse: legacy.parse,
  });
}

export function selectedCatalogProbe(
  probe: Exclude<CliCatalogProbe, { kind: 'not-run' }>,
  refresh: 'automatic' | 'manual',
): Exclude<CliCatalogProbe, { kind: 'not-run' }> {
  if (refresh !== 'manual' || probe.manualCommand === undefined) return probe;
  return Object.freeze({ ...probe, command: immutableProbeCommand(probe.manualCommand) });
}

export function admitCatalogOperation(
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
  if (
    executable === undefined ||
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
    authChannel: immutableAuthChannel(defaultCliAuthChannel(input.context.id)),
    issuedAt: input.issuedAt,
  });
}

export function catalogOperationIsFresh(operation: AdmittedCatalogOperation, now: number): boolean {
  const age = now - operation.issuedAt;
  return Number.isFinite(age) && age >= 0 && age <= CATALOG_ADMISSION_MAX_AGE_MS;
}

export function catalogRuntimePath(): string {
  const directories =
    process.platform === 'win32'
      ? [dirname(process.execPath)]
      : [dirname(process.execPath), '/usr/bin', '/bin'];
  return [...new Set(directories)].join(delimiter);
}
