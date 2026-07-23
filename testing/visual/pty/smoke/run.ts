import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanupTempDir, createTempDir } from '../../../helpers/temp-dir.js';
import { formatViewport, type Viewport } from '../../contracts/geometry.js';
import { PTY_CHILD_OUTPUT, PTY_CHILD_SCENARIO, PTY_CHILD_VIEWPORT } from '../child.js';
import {
  loadNodePtyCapability,
  type PtyCapability,
  type PtyProcess,
  type PtySpawnOptions,
} from './capability.js';
import { monitorChild } from './monitor.js';

export interface PtySmokeDependencies {
  readonly loadCapability: () => Promise<PtyCapability>;
}

export interface RunPtySmokeOptions {
  readonly viewport: Viewport;
  readonly timeoutMs: number;
}

export type PtySmokeResult =
  | { readonly status: 'skipped'; readonly reason: string }
  | {
      readonly status: 'passed';
      readonly viewport: Viewport;
      readonly marker: string;
      readonly rawIo: string;
      readonly pid: number;
      readonly exitCode: number;
      readonly resizeVerified: true;
      readonly terminalRestored: true;
      readonly processGroupReaped: true;
    };

const DEFAULT_DEPENDENCIES: PtySmokeDependencies = {
  loadCapability: loadNodePtyCapability,
};

export async function runPtySmoke(
  options: RunPtySmokeOptions,
  dependencies: PtySmokeDependencies = DEFAULT_DEPENDENCIES,
): Promise<PtySmokeResult> {
  assertSmokeOptions(options);
  const capability = await dependencies.loadCapability();
  if (capability.kind === 'unavailable') return capabilityToSkip(capability);

  const environmentRoot = createTempDir('diptych-pty-environment');
  try {
    const processOptions: PtySpawnOptions = {
      name: 'xterm-256color',
      cols: options.viewport.cols,
      rows: options.viewport.rows,
      cwd: projectRoot(),
      env: safeChildEnvironment(environmentRoot),
    };
    let child: PtyProcess;
    try {
      child = capability.spawn(process.execPath, childArgv(), processOptions);
    } catch {
      return {
        status: 'skipped',
        reason: 'node-pty could not create a pseudoterminal on this platform',
      };
    }
    return await monitorChild({ child, options });
  } finally {
    cleanupTempDir(environmentRoot);
  }
}

function childArgv(): readonly string[] {
  return [
    '--import',
    'tsx',
    childEntrypoint(),
    '--scenario',
    PTY_CHILD_SCENARIO,
    '--output',
    PTY_CHILD_OUTPUT,
  ];
}

export function safeChildEnvironment(environmentRoot: string): Readonly<Record<string, string>> {
  const env: Record<string, string> = {
    HOME: environmentRoot,
    USERPROFILE: environmentRoot,
    XDG_CONFIG_HOME: join(environmentRoot, 'xdg'),
    TMPDIR: tmpdir(),
    TEMP: tmpdir(),
    TMP: tmpdir(),
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    FORCE_COLOR: '3',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    TZ: 'UTC',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    DIPTYCH_QUIET: '1',
    NODE_NO_WARNINGS: '1',
  };
  for (const name of ['PATH', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT']) {
    const value = process.env[name];
    if (value) env[name] = value;
  }
  return Object.freeze(env);
}

function projectRoot(): string {
  return fileURLToPath(new URL('../../../../', import.meta.url));
}

function childEntrypoint(): string {
  return fileURLToPath(new URL('../child.ts', import.meta.url));
}

function capabilityToSkip(
  capability: Extract<PtyCapability, { readonly kind: 'unavailable' }>,
): Extract<PtySmokeResult, { readonly status: 'skipped' }> {
  return { status: 'skipped', reason: capability.reason };
}

function assertSmokeOptions(options: RunPtySmokeOptions): void {
  if (
    options.viewport.cols !== PTY_CHILD_VIEWPORT.cols ||
    options.viewport.rows !== PTY_CHILD_VIEWPORT.rows
  ) {
    throw new Error(`PTY smoke supports only ${formatViewport(PTY_CHILD_VIEWPORT)}`);
  }
  if (
    !Number.isInteger(options.timeoutMs) ||
    options.timeoutMs <= 0 ||
    options.timeoutMs > 30_000
  ) {
    throw new Error('PTY smoke timeout must be an integer from 1 to 30000 milliseconds');
  }
}
