import { chmodSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { CLI_TOOL_CATALOG } from '../../src/core/runners/cli-tool/catalog.js';
import { shellQuoteArg } from '../../src/utils/shell-quote.js';
import { cleanupTempDir, createTempDir } from './temp-dir.js';

type CompatibleCliTool = 'claude-code' | 'codex';

type ShimInvocation = Readonly<{
  marker?: Readonly<{
    path: string;
    environment: string;
  }>;
  stdoutLines?: readonly string[] | undefined;
}>;

export type CompatibleCliShim = Readonly<{
  path: string;
  sessionStateHome: string;
}>;

export interface InstallCompatibleCliShimOptions {
  readonly directory: string;
  readonly tool: CompatibleCliTool;
  readonly version?: string | undefined;
  readonly invocation?: ShimInvocation | undefined;
  /**
   * `unverified` prints a positive status but exits non-zero, the one shape the
   * readiness probe still resolves to `unknown` auth — the state a fail-closed
   * headless start refuses on.
   */
  readonly authProbe?: 'verified' | 'unverified' | undefined;
}

function exactArgumentsCondition(arguments_: readonly string[]): string {
  return [
    `[ "$#" -eq ${arguments_.length} ]`,
    ...arguments_.map((argument, index) => `[ "\${${index + 1}:-}" = ${shellQuoteArg(argument)} ]`),
  ].join(' && ');
}

function versionOutput(tool: CompatibleCliTool, version: string): string {
  return `${CLI_TOOL_CATALOG[tool].command} ${version}`;
}

function authProbeArguments(tool: CompatibleCliTool): readonly string[] {
  return tool === 'codex' ? ['login', 'status'] : ['auth', 'status'];
}

function markerLines(marker: NonNullable<ShimInvocation['marker']> | undefined): readonly string[] {
  if (marker === undefined) return [];
  if (!/^[A-Z_][A-Z0-9_]*$/u.test(marker.environment)) {
    throw new Error(`Invalid compatible CLI shim marker environment name: ${marker.environment}`);
  }
  return [`printf '%s\\n' "\${${marker.environment}:-}" > ${shellQuoteArg(marker.path)}`];
}

function createSessionStateHome(tool: CompatibleCliTool, directory: string): string {
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

  const version = options.version ?? descriptor.compatibility.testedVersion;
  const command = descriptor.command;
  const sessionStateHome = createSessionStateHome(options.tool, options.directory);
  const script = [
    '#!/bin/sh',
    `if ${exactArgumentsCondition(['--version'])}; then`,
    `  printf '%s\\n' ${shellQuoteArg(versionOutput(options.tool, version))}`,
    '  exit 0',
    'fi',
    `if ${exactArgumentsCondition(authProbeArguments(options.tool))}; then`,
    "  printf 'authenticated\\n'",
    `  exit ${options.authProbe === 'unverified' ? 1 : 0}`,
    'fi',
    'cat >/dev/null',
    ...markerLines(options.invocation?.marker),
    ...(options.invocation?.stdoutLines ?? []).map(
      (line) => `printf '%s\\n' ${shellQuoteArg(line)}`,
    ),
    'exit 0',
    '',
  ].join('\n');
  const path = join(options.directory, command);
  writeFileSync(path, script, 'utf8');
  chmodSync(path, 0o755);
  return {
    path: realpathSync(path),
    sessionStateHome,
  };
}

let nodeRuntimeDirectory: string | undefined;

function nodeRuntime(): string {
  if (nodeRuntimeDirectory === undefined) {
    // Only node, npm and npx: the node install directory also holds the developer's
    // global CLIs, which detection would otherwise find and run.
    const directory = createTempDir('compatible-cli-node-runtime');
    const installBin = dirname(process.execPath);
    symlinkSync(process.execPath, join(directory, 'node'));
    for (const name of ['npm', 'npx']) {
      symlinkSync(realpathSync(join(installBin, name)), join(directory, name));
    }
    process.once('exit', disposeNodeRuntime);
    nodeRuntimeDirectory = directory;
  }
  return nodeRuntimeDirectory;
}

/**
 * Removes this process's node runtime directory. Vitest ends a worker with SIGTERM,
 * which emits no `exit`, so the setup file calls it after each test file (`state-home.ts`).
 */
export function disposeNodeRuntime(): void {
  if (nodeRuntimeDirectory === undefined) return;
  cleanupTempDir(nodeRuntimeDirectory);
  nodeRuntimeDirectory = undefined;
}

/**
 * The hermetic test PATH: the shim directories, this process's node runtime directory,
 * then the system directories. `safeChildEnvironment` gives it to PTY children; the test
 * process gets it only through `activateSafeCliShimPath`.
 */
export function hermeticPath(shimDirectories: readonly string[]): string {
  return [...new Set([...shimDirectories, nodeRuntime(), '/usr/bin', '/bin'])].join(delimiter);
}

/** Places a test shim first on a deliberately small, absolute parent PATH. */
export function activateSafeCliShimPath(directory: string): () => void {
  if (!isAbsolute(directory)) {
    throw new Error('Compatible CLI shim PATH entries must be absolute.');
  }
  const originalPath = process.env.PATH;
  process.env.PATH = hermeticPath([directory]);
  return () => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  };
}

/** Puts the shim first on the hermetic PATH and points HOME at its session sign-in. */
export function activateCompatibleCliShim(shim: CompatibleCliShim): () => void {
  const restorePath = activateSafeCliShimPath(dirname(shim.path));
  const originalHome = process.env.HOME;
  process.env.HOME = shim.sessionStateHome;
  return () => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    restorePath();
  };
}
