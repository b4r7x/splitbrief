import { chmodSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import {
  CLI_TOOL_CATALOG,
  selectCliAuthChannel,
  type CliAuthChannelId,
} from '../../src/core/runners/cli-tool-catalog.js';

type CompatibleCliTool = 'claude-code' | 'codex';

type ShimInvocation = Readonly<{
  marker?: Readonly<{
    path: string;
    environment: string;
  }>;
  stdoutLines?: readonly string[] | undefined;
}>;

export type CompatibleCliShim = Readonly<{
  tool: CompatibleCliTool;
  authChannel: CliAuthChannelId;
  path: string;
  credentialEnvironmentNames: readonly string[];
  sessionStateHome?: string | undefined;
}>;

export interface InstallCompatibleCliShimOptions {
  readonly directory: string;
  readonly tool: CompatibleCliTool;
  readonly authChannel: CliAuthChannelId;
  readonly version?: string | undefined;
  readonly invocation?: ShimInvocation | undefined;
  /**
   * `unverified` prints a positive status but exits non-zero, the one shape the
   * readiness probe still resolves to `unknown` auth — the state a fail-closed
   * headless start refuses on.
   */
  readonly authProbe?: 'verified' | 'unverified' | undefined;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function exactArgumentsCondition(arguments_: readonly string[]): string {
  return [
    `[ "$#" -eq ${arguments_.length} ]`,
    ...arguments_.map((argument, index) => `[ "\${${index + 1}:-}" = ${shellQuote(argument)} ]`),
  ].join(' && ');
}

function versionOutput(tool: CompatibleCliTool, version: string): string {
  return `${CLI_TOOL_CATALOG[tool].command} ${version}`;
}

function authProbeArguments(tool: CompatibleCliTool): readonly string[] {
  return tool === 'codex' ? ['login', 'status'] : ['auth', 'status'];
}

function requiredCredentialLines(environmentNames: readonly string[]): readonly string[] {
  if (environmentNames.length === 0) return [];
  const allMissing = environmentNames.map((name) => `[ -z "\${${name}:-}" ]`).join(' && ');
  return [
    `  if ${allMissing}; then`,
    "    printf 'missing credential\\n' >&2",
    '    exit 1',
    '  fi',
  ];
}

function markerLines(marker: NonNullable<ShimInvocation['marker']> | undefined): readonly string[] {
  if (marker === undefined) return [];
  if (!/^[A-Z_][A-Z0-9_]*$/u.test(marker.environment)) {
    throw new Error(`Invalid compatible CLI shim marker environment name: ${marker.environment}`);
  }
  return [`printf '%s\\n' "\${${marker.environment}:-}" > ${shellQuote(marker.path)}`];
}

function createSessionStateHome(
  tool: CompatibleCliTool,
  stateBridge: 'host-cli-state' | 'none',
  directory: string,
): string | undefined {
  if (stateBridge !== 'host-cli-state') return undefined;
  const home = join(directory, 'host-state');
  const relativeCredentialPath =
    tool === 'claude-code' ? '.claude/.credentials.json' : '.codex/auth.json';
  const credentialPath = join(home, relativeCredentialPath);
  mkdirSync(dirname(credentialPath), { recursive: true, mode: 0o700 });
  writeFileSync(credentialPath, '{"fixture":true}\n', { encoding: 'utf8', mode: 0o600 });
  return home;
}

/**
 * Installs a physical CLI that satisfies the active descriptor's exact version
 * and authentication probes. Callers still put it on PATH and run the real
 * resolver, so this fixture cannot manufacture a legacy readiness receipt.
 */
export function installCompatibleCliShim(
  options: InstallCompatibleCliShimOptions,
): CompatibleCliShim {
  if (!isAbsolute(options.directory)) {
    throw new Error('Compatible CLI shims must be installed in an absolute directory.');
  }
  const descriptor = CLI_TOOL_CATALOG[options.tool];
  const channel = selectCliAuthChannel(options.tool, { channel: options.authChannel });
  if (channel === undefined) {
    throw new Error(
      `CLI tool ${options.tool} does not support auth channel ${options.authChannel}.`,
    );
  }

  const version = options.version ?? descriptor.compatibility.testedVersion;
  const command = descriptor.command;
  const sessionStateHome = createSessionStateHome(
    options.tool,
    channel.stateBridge,
    options.directory,
  );
  const script = [
    '#!/bin/sh',
    `if ${exactArgumentsCondition(['--version'])}; then`,
    `  printf '%s\\n' ${shellQuote(versionOutput(options.tool, version))}`,
    '  exit 0',
    'fi',
    `if ${exactArgumentsCondition(authProbeArguments(options.tool))}; then`,
    ...requiredCredentialLines(channel.env),
    "  printf 'authenticated\\n'",
    `  exit ${options.authProbe === 'unverified' ? 1 : 0}`,
    'fi',
    ...markerLines(options.invocation?.marker),
    ...(options.invocation?.stdoutLines ?? []).map((line) => `printf '%s\\n' ${shellQuote(line)}`),
    'exit 0',
    '',
  ].join('\n');
  const path = join(options.directory, command);
  writeFileSync(path, script, 'utf8');
  chmodSync(path, 0o755);
  return {
    tool: options.tool,
    authChannel: options.authChannel,
    path: realpathSync(path),
    credentialEnvironmentNames: [...channel.env],
    sessionStateHome,
  };
}

function safeRuntimePath(directory: string): string {
  const entries =
    process.platform === 'win32'
      ? [directory, dirname(process.execPath)]
      : [directory, dirname(process.execPath), '/usr/bin', '/bin'];
  return [...new Set(entries)].join(delimiter);
}

/** Places a test shim first on a deliberately small, absolute parent PATH. */
export function activateSafeCliShimPath(directory: string): () => void {
  if (!isAbsolute(directory)) {
    throw new Error('Compatible CLI shim PATH entries must be absolute.');
  }
  const originalPath = process.env.PATH;
  process.env.PATH = safeRuntimePath(directory);
  return () => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  };
}

/**
 * Activates the selected auth channel without inheriting an ambient test key.
 * A credential-bearing channel requires an explicit fixture value.
 */
export function activateCompatibleCliShim(
  shim: CompatibleCliShim,
  credentialValue?: string | undefined,
): () => void {
  const restorePath = activateSafeCliShimPath(dirname(shim.path));
  const originalHome = process.env.HOME;
  const priorValues = new Map<string, string | undefined>();
  if (shim.credentialEnvironmentNames.length > 0 && credentialValue === undefined) {
    restorePath();
    throw new Error(`Compatible ${shim.tool} shim requires an explicit test credential.`);
  }
  for (const name of shim.credentialEnvironmentNames) {
    priorValues.set(name, process.env[name]);
    if (credentialValue !== undefined) process.env[name] = credentialValue;
  }
  if (shim.sessionStateHome !== undefined) process.env.HOME = shim.sessionStateHome;
  return () => {
    for (const [name, priorValue] of priorValues) {
      if (priorValue === undefined) delete process.env[name];
      else process.env[name] = priorValue;
    }
    if (shim.sessionStateHome !== undefined) {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
    }
    restorePath();
  };
}
