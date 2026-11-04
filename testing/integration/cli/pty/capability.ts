import { chmodSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import type { PtySetupFailureCategory } from './contract.js';

const require = createRequire(import.meta.url);

const NODE_PTY_PACKAGE = 'node-pty';
const POST_SPAWN_API_INCOMPATIBLE_ERROR_NAME = 'pty-post-spawn-api-incompatible';
const POST_SPAWN_PROCESS_PROPERTY = 'ptyProcess';

export interface Disposable {
  readonly dispose: () => void;
}

export interface PtyProcessBoundary {
  readonly pid: number;
  readonly onExit: (listener: (event: PtyExitEvent) => void) => Disposable;
  readonly kill: (signal?: string) => void;
}

export interface PtyProcess extends PtyProcessBoundary {
  readonly onData: (listener: (data: string) => void) => Disposable;
  readonly write: (data: string) => void;
}

export interface PtyExitEvent {
  readonly exitCode: number;
  readonly signal?: number | undefined;
}

export interface PtySpawnOptions {
  readonly name: string;
  readonly cols: number;
  readonly rows: number;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

export type PtySpawn = (
  executable: string,
  argv: readonly string[],
  options: PtySpawnOptions,
) => PtyProcess;

type PtySetupFailed = {
  readonly kind: 'setup-failed';
  readonly category: Exclude<PtySetupFailureCategory, 'spawn-failed'>;
  readonly reason: string;
};

export type PtyCapability =
  | { readonly kind: 'available'; readonly spawn: PtySpawn }
  | PtySetupFailed;

export async function loadNodePtyCapability(): Promise<PtyCapability> {
  let loaded: unknown;
  try {
    loaded = await import(NODE_PTY_PACKAGE);
  } catch {
    return {
      kind: 'setup-failed',
      category: 'module-unavailable',
      reason: 'node-pty is unavailable on this platform',
    };
  }

  const spawn = resolvePtySpawn(loaded);
  if (spawn === null) {
    return {
      kind: 'setup-failed',
      category: 'api-incompatible',
      reason: 'node-pty has an incompatible spawn API',
    };
  }
  if (process.platform === 'darwin') {
    const helperFailure = makeSpawnHelperExecutable();
    if (helperFailure !== null) return helperFailure;
  }
  return { kind: 'available', spawn };
}

// node-pty 1.1.0 ships its darwin spawn-helper prebuilds as mode 644, so every spawn fails until the exec bit is set.
function makeSpawnHelperExecutable(): PtySetupFailed | null {
  const utilsPath = require.resolve(`${NODE_PTY_PACKAGE}/lib/utils.js`);
  const utils: unknown = require(utilsPath);
  const native =
    isRecord(utils) && isCallable(utils['loadNativeModule'])
      ? utils['loadNativeModule']('pty')
      : undefined;
  if (!isRecord(native) || typeof native['dir'] !== 'string') {
    return {
      kind: 'setup-failed',
      category: 'api-incompatible',
      reason: 'node-pty does not expose the directory of its native module',
    };
  }
  const helperPath = resolve(dirname(utilsPath), native['dir'], 'spawn-helper');
  const stats = statSync(helperPath, { throwIfNoEntry: false });
  if (stats === undefined || (stats.mode & 0o100) !== 0) return null;
  try {
    chmodSync(helperPath, stats.mode | 0o111);
  } catch (error) {
    return {
      kind: 'setup-failed',
      category: 'module-unavailable',
      reason: `node-pty spawn-helper at ${helperPath} is not executable and chmod failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return null;
}

export function isPostSpawnApiIncompatibleError(error: unknown): boolean {
  return error instanceof Error && error.name === POST_SPAWN_API_INCOMPATIBLE_ERROR_NAME;
}

export function postSpawnProcessBoundary(error: unknown): PtyProcessBoundary | undefined {
  if (!isPostSpawnApiIncompatibleError(error) || !isRecord(error)) return undefined;
  const process = error[POST_SPAWN_PROCESS_PROPERTY];
  return isPtyProcessBoundary(process) ? process : undefined;
}

export function resolvePtySpawn(moduleValue: unknown): PtySpawn | null {
  if (!isRecord(moduleValue)) return null;
  const direct = moduleValue['spawn'];
  if (isCallable(direct)) return bindSpawn(moduleValue, direct);
  const defaultExport = moduleValue['default'];
  if (!isRecord(defaultExport) || !isCallable(defaultExport['spawn'])) return null;
  return bindSpawn(defaultExport, defaultExport['spawn']);
}

export function resolvePtyDisposable(value: unknown): Disposable | null {
  if (!isRecord(value) || !isCallable(value['dispose'])) return null;
  const dispose = value['dispose'];
  return {
    dispose: () => {
      Reflect.apply(dispose, value, []);
    },
  };
}

function bindSpawn(
  owner: Readonly<Record<string, unknown>>,
  spawn: (...args: unknown[]) => unknown,
): PtySpawn {
  return (executable, argv, options) => {
    const value = Reflect.apply(spawn, owner, [executable, [...argv], options]);
    if (!isPtyProcess(value)) {
      const error = new Error('node-pty returned an incompatible process API');
      error.name = POST_SPAWN_API_INCOMPATIBLE_ERROR_NAME;
      if (isPtyProcessBoundary(value)) {
        Object.defineProperty(error, POST_SPAWN_PROCESS_PROPERTY, { value });
      }
      throw error;
    }
    return value;
  };
}

function isPtyProcessBoundary(value: unknown): value is PtyProcessBoundary {
  return (
    isRecord(value) &&
    typeof value['pid'] === 'number' &&
    isCallable(value['onExit']) &&
    isCallable(value['kill'])
  );
}

function isPtyProcess(value: unknown): value is PtyProcess {
  return (
    isRecord(value) &&
    isCompatiblePtyPid(value['pid']) &&
    isCallable(value['onData']) &&
    isCallable(value['onExit']) &&
    isCallable(value['write']) &&
    isCallable(value['kill'])
  );
}

function isCompatiblePtyPid(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isSafeInteger(value) && value > 1 && value !== process.pid
  );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null;
}

function isCallable(value: unknown): value is (...args: unknown[]) => unknown {
  return typeof value === 'function';
}
