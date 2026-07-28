import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanupTempDir, createTempDir } from '../../../helpers/temp-dir.js';
import {
  isPostSpawnApiIncompatibleError,
  loadNodePtyCapability,
  postSpawnProcessBoundary,
  resolvePtyDisposable,
  type Disposable,
  type PtyCapability,
  type PtyExitEvent,
  type PtyProcess,
  type PtyProcessBoundary,
  type PtySpawnOptions,
} from './capability.js';
import {
  PTY_CHILD_PROJECT_ENV,
  PTY_EDITOR_SENTINEL_ENV,
  PTY_VIEWPORT,
  type PtyRequirement,
  type PtySetupFailureCategory,
} from './contract.js';
import { editorChildEntrypoint } from './editor-child.js';
import { monitorPtyContract, terminatePtyProcessGroup, type PtyContractResult } from './monitor.js';

export interface PtySmokeDependencies {
  readonly loadCapability: () => Promise<PtyCapability>;
}

export interface RunPtySmokeOptions {
  readonly timeoutMs: number;
  readonly requirement: PtyRequirement;
}

export type PtySmokeResult =
  | {
      readonly status: 'skipped';
      readonly category: PtySetupFailureCategory;
      readonly reason: string;
    }
  | ({ readonly status: 'passed' } & PtyContractResult);

const DEFAULT_DEPENDENCIES: PtySmokeDependencies = {
  loadCapability: loadNodePtyCapability,
};

export async function runPtySmoke(
  options: RunPtySmokeOptions,
  dependencies: PtySmokeDependencies = DEFAULT_DEPENDENCIES,
): Promise<PtySmokeResult> {
  assertOptions(options);
  const capability = await dependencies.loadCapability();
  if (capability.kind === 'setup-failed') {
    return setupFailure(options.requirement, capability.category, capability.reason);
  }

  const environmentRoot = createTempDir('splitbrief-pty-environment');
  let child: PtyProcess;
  try {
    const processOptions: PtySpawnOptions = {
      name: 'xterm-256color',
      cols: PTY_VIEWPORT.cols,
      rows: PTY_VIEWPORT.rows,
      cwd: projectRoot(),
      env: safeChildEnvironment(environmentRoot),
    };
    try {
      child = capability.spawn(process.execPath, childArgv(), processOptions);
    } catch (error) {
      if (isPostSpawnApiIncompatibleError(error)) {
        const processBoundary = postSpawnProcessBoundary(error);
        const fatal = new Error('node-pty returned an incompatible process API after spawning');
        fatal.name = 'pty-contract-api-incompatible';
        if (processBoundary) await reapPostSpawnBoundary(processBoundary, fatal);
        throw fatal;
      }
      return setupFailure(
        options.requirement,
        'spawn-failed',
        'node-pty could not create a pseudoterminal',
      );
    }

    const result = await monitorPtyContract({ child, timeoutMs: options.timeoutMs });
    return { status: 'passed', ...result };
  } finally {
    cleanupTempDir(environmentRoot);
  }
}

async function reapPostSpawnBoundary(
  processBoundary: PtyProcessBoundary,
  primaryError: Error,
): Promise<void> {
  const { promise: exitPromise, resolve: resolveExit } = Promise.withResolvers<PtyExitEvent>();
  let disposable: Disposable | undefined;
  let exitObservationAvailable = false;
  try {
    let registrationFailure: unknown;
    let registration: unknown;
    try {
      registration = processBoundary.onExit(resolveExit);
      exitObservationAvailable = true;
    } catch (error) {
      registrationFailure = error;
    }
    disposable = resolvePtyDisposable(registration) ?? undefined;
    if (!disposable && registrationFailure === undefined) {
      registrationFailure = new Error('PTY child exit listener returned an invalid disposable');
    }
    if (registrationFailure !== undefined) {
      const listenerError = new Error('PTY child exit listener registration failed', {
        cause: new AggregateError(
          [primaryError, registrationFailure],
          'PTY API incompatibility and cleanup listener registration both failed',
        ),
      });
      listenerError.name = 'pty-contract-listener';
      await terminatePtyProcessGroup(
        processBoundary,
        exitObservationAvailable ? exitPromise : undefined,
        listenerError,
      );
      throw listenerError;
    }
    await terminatePtyProcessGroup(processBoundary, exitPromise, primaryError);
  } finally {
    disposable?.dispose();
  }
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
    SPLITBRIEF_QUIET: '1',
    NODE_NO_WARNINGS: '1',
    VISUAL: `${quoteCommandToken(process.execPath)} --import tsx ${quoteCommandToken(editorChildEntrypoint())}`,
    [PTY_CHILD_PROJECT_ENV]: join(environmentRoot, 'project'),
    [PTY_EDITOR_SENTINEL_ENV]: join(environmentRoot, 'editor-ran'),
  };
  for (const name of ['PATH', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT']) {
    const value = process.env[name];
    if (value) env[name] = value;
  }
  return Object.freeze(env);
}

function childArgv(): readonly string[] {
  return ['--import', 'tsx', fileURLToPath(new URL('./child.ts', import.meta.url))];
}

function projectRoot(): string {
  return fileURLToPath(new URL('../../../../', import.meta.url));
}

function quoteCommandToken(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function setupFailure(
  requirement: PtyRequirement,
  category: PtySetupFailureCategory,
  reason: string,
): Extract<PtySmokeResult, { readonly status: 'skipped' }> {
  if (requirement === 'required') {
    const error = new Error(`Required PTY setup failed (${category}): ${reason}`);
    error.name = `pty-setup-${category}`;
    throw error;
  }
  return { status: 'skipped', category, reason };
}

function assertOptions(options: RunPtySmokeOptions): void {
  if (
    !Number.isInteger(options.timeoutMs) ||
    options.timeoutMs <= 0 ||
    options.timeoutMs > 30_000
  ) {
    throw new Error('PTY timeout must be an integer from 1 to 30000 milliseconds');
  }
}
