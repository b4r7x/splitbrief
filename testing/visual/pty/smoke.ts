import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { terminalSequences } from '../../../src/lib/terminal/control.js';
import { stripTerminalControls } from '../../../src/utils/display-text.js';
import { cleanupTempDir, createTempDir } from '../../helpers/temp-dir.js';
import { formatViewport, parseViewport, type Viewport } from '../contracts/geometry.js';
import {
  PTY_CHILD_EXIT_INPUT,
  PTY_CHILD_MARKER,
  PTY_CHILD_OUTPUT,
  PTY_CHILD_SCENARIO,
  PTY_CHILD_VIEWPORT,
} from './child.js';

const NODE_PTY_PACKAGE = 'node-pty';
const DEFAULT_TIMEOUT_MS = 10_000;
const TERMINATION_GRACE_MS = 250;
const FORCE_SETTLE_MS = 750;
const MAX_RAW_IO_CODE_UNITS = 1_048_576;

interface Disposable {
  readonly dispose: () => void;
}

export interface PtyProcess {
  readonly pid: number;
  readonly cols: number;
  readonly rows: number;
  readonly onData: (listener: (data: string) => void) => Disposable;
  readonly onExit: (listener: (event: PtyExitEvent) => void) => Disposable;
  readonly resize: (cols: number, rows: number) => void;
  readonly write: (data: string) => void;
  readonly kill: (signal?: string) => void;
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

export type PtyCapability =
  | { readonly kind: 'available'; readonly spawn: PtySpawn }
  | { readonly kind: 'unavailable'; readonly reason: string };

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

export function parsePtySmokeArgs(argv: readonly string[]): RunPtySmokeOptions {
  let viewport: Viewport = PTY_CHILD_VIEWPORT;
  let sawViewport = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument !== '--viewport' || sawViewport) {
      throw new Error('PTY smoke accepts only one --viewport option');
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error('PTY smoke --viewport requires a value');
    }
    viewport = parseViewport(value);
    sawViewport = true;
    index += 1;
  }
  if (viewport.cols !== PTY_CHILD_VIEWPORT.cols || viewport.rows !== PTY_CHILD_VIEWPORT.rows) {
    throw new Error(`PTY smoke supports only ${formatViewport(PTY_CHILD_VIEWPORT)}`);
  }
  return { viewport, timeoutMs: DEFAULT_TIMEOUT_MS };
}

export async function loadNodePtyCapability(): Promise<PtyCapability> {
  try {
    const loaded: unknown = await import(NODE_PTY_PACKAGE);
    const spawn = spawnAdapter(loaded);
    if (spawn === null) {
      return {
        kind: 'unavailable',
        reason: 'node-pty loaded without a compatible spawn API',
      };
    }
    return { kind: 'available', spawn };
  } catch {
    return {
      kind: 'unavailable',
      reason: 'node-pty optional capability is unavailable on this platform',
    };
  }
}

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

function monitorChild(input: {
  readonly child: PtyProcess;
  readonly options: RunPtySmokeOptions;
}): Promise<Extract<PtySmokeResult, { readonly status: 'passed' }>> {
  const { child, options } = input;
  return new Promise((resolvePromise, rejectPromise) => {
    let rawIo = '';
    let markerSeen = false;
    let exitInputSent = false;
    let settled = false;
    let termination: 'timeout' | 'output-limit' | 'signal' | null = null;
    let terminationTimer: NodeJS.Timeout | undefined;
    let forceSettleTimer: NodeJS.Timeout | undefined;

    const finish = (event: PtyExitEvent): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (terminationTimer) clearTimeout(terminationTimer);
      if (forceSettleTimer) clearTimeout(forceSettleTimer);
      dataDisposable.dispose();
      exitDisposable.dispose();
      removeSignalListeners();

      if (termination !== null) {
        rejectPromise(terminationError(termination));
        return;
      }
      if (!markerSeen || !exitInputSent) {
        rejectPromise(ptyError('pty-smoke-marker-missing', 'PTY child exited before its marker'));
        return;
      }
      if (event.exitCode !== 0) {
        rejectPromise(
          ptyError('pty-smoke-child-exit', `PTY child exited with code ${event.exitCode}`),
        );
        return;
      }
      if (!hasRestoredTerminal(rawIo)) {
        rejectPromise(
          ptyError('pty-smoke-restoration', 'PTY child did not restore fullscreen terminal state'),
        );
        return;
      }
      resolvePromise({
        status: 'passed',
        viewport: options.viewport,
        marker: PTY_CHILD_MARKER,
        rawIo,
        pid: child.pid,
        exitCode: event.exitCode,
        resizeVerified: true,
        terminalRestored: true,
        processGroupReaped: true,
      });
    };

    const forceFinish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (terminationTimer) clearTimeout(terminationTimer);
      dataDisposable.dispose();
      exitDisposable.dispose();
      removeSignalListeners();
      rejectPromise(
        ptyError('pty-smoke-cleanup', 'PTY child did not exit after process-group cleanup'),
      );
    };

    const terminate = (reason: Exclude<typeof termination, null>): void => {
      if (termination !== null || settled) return;
      termination = reason;
      signalProcessGroup(child, 'SIGTERM');
      if (settled) return;
      terminationTimer = setTimeout(
        () => signalProcessGroup(child, 'SIGKILL'),
        TERMINATION_GRACE_MS,
      );
      forceSettleTimer = setTimeout(forceFinish, FORCE_SETTLE_MS);
    };

    const onSignal = (): void => terminate('signal');
    const removeSignalListeners = (): void => {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
    };

    const dataDisposable = child.onData((data) => {
      if (settled) return;
      rawIo += data;
      if (rawIo.length > MAX_RAW_IO_CODE_UNITS) {
        terminate('output-limit');
        return;
      }
      if (!markerSeen && rawIo.includes(PTY_CHILD_MARKER)) {
        markerSeen = true;
        exitInputSent = true;
        child.write(PTY_CHILD_EXIT_INPUT);
      }
    });
    const exitDisposable = child.onExit(finish);
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    const timeoutTimer = setTimeout(() => terminate('timeout'), options.timeoutMs);

    try {
      verifyResizeRoundTrip(child, options.viewport);
    } catch (error) {
      terminate('signal');
      if (!settled) {
        settled = true;
        clearTimeout(timeoutTimer);
        if (terminationTimer) clearTimeout(terminationTimer);
        if (forceSettleTimer) clearTimeout(forceSettleTimer);
        dataDisposable.dispose();
        exitDisposable.dispose();
        removeSignalListeners();
        rejectPromise(error);
      }
    }
  });
}

function verifyResizeRoundTrip(child: PtyProcess, viewport: Viewport): void {
  if (child.cols !== viewport.cols || child.rows !== viewport.rows) {
    throw ptyError('pty-smoke-viewport', 'PTY child did not start at the declared viewport');
  }
  child.resize(viewport.cols + 1, viewport.rows + 1);
  if (child.cols !== viewport.cols + 1 || child.rows !== viewport.rows + 1) {
    throw ptyError('pty-smoke-resize', 'PTY child did not report its resized viewport');
  }
  child.resize(viewport.cols, viewport.rows);
  if (child.cols !== viewport.cols || child.rows !== viewport.rows) {
    throw ptyError('pty-smoke-resize', 'PTY child did not restore its declared viewport');
  }
}

function signalProcessGroup(child: PtyProcess, signal: 'SIGTERM' | 'SIGKILL'): void {
  if (child.pid <= 1 || child.pid === process.pid) return;
  if (process.platform !== 'win32') {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // node-pty implementations without a separate process group use their own kill boundary.
    }
  }
  try {
    child.kill(process.platform === 'win32' ? undefined : signal);
  } catch {
    // A concurrent clean exit means there is no remaining PTY process to kill.
  }
}

function hasRestoredTerminal(rawIo: string): boolean {
  const entered = rawIo.lastIndexOf(terminalSequences.enterAltBuffer);
  const hidden = rawIo.lastIndexOf(terminalSequences.hideCursor);
  const exited = rawIo.lastIndexOf(terminalSequences.exitAltBuffer);
  const shown = rawIo.lastIndexOf(terminalSequences.showCursor);
  return entered >= 0 && exited > entered && (hidden < 0 || shown > hidden);
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

function safeChildEnvironment(environmentRoot: string): Readonly<Record<string, string>> {
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
  return fileURLToPath(new URL('../../../', import.meta.url));
}

function childEntrypoint(): string {
  return fileURLToPath(new URL('./child.ts', import.meta.url));
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

function terminationError(reason: 'timeout' | 'output-limit' | 'signal'): Error {
  switch (reason) {
    case 'timeout':
      return ptyError('pty-smoke-timeout', 'PTY child timed out before clean exit');
    case 'output-limit':
      return ptyError('pty-smoke-output-limit', 'PTY child exceeded the raw I/O capture limit');
    case 'signal':
      return ptyError('pty-smoke-interrupted', 'PTY smoke was interrupted');
  }
}

function ptyError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

function spawnAdapter(moduleValue: unknown): PtySpawn | null {
  if (!isRecord(moduleValue)) return null;
  const direct = moduleValue['spawn'];
  if (isCallable(direct)) return bindSpawn(moduleValue, direct);
  const defaultExport = moduleValue['default'];
  if (!isRecord(defaultExport) || !isCallable(defaultExport['spawn'])) return null;
  return bindSpawn(defaultExport, defaultExport['spawn']);
}

function bindSpawn(
  owner: Readonly<Record<string, unknown>>,
  spawn: (...args: unknown[]) => unknown,
): PtySpawn {
  return (executable, argv, options) => {
    const value = Reflect.apply(spawn, owner, [executable, [...argv], options]);
    if (!isPtyProcess(value)) throw new Error('node-pty returned an incompatible process API');
    return value;
  };
}

function isPtyProcess(value: unknown): value is PtyProcess {
  return (
    isRecord(value) &&
    typeof value['pid'] === 'number' &&
    typeof value['cols'] === 'number' &&
    typeof value['rows'] === 'number' &&
    isCallable(value['onData']) &&
    isCallable(value['onExit']) &&
    isCallable(value['resize']) &&
    isCallable(value['write']) &&
    isCallable(value['kill'])
  );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null;
}

function isCallable(value: unknown): value is (...args: unknown[]) => unknown {
  return typeof value === 'function';
}

function isDirectExecution(): boolean {
  const entrypoint = process.argv[1];
  if (!entrypoint || !existsSync(entrypoint)) return false;
  return pathToFileURL(resolve(entrypoint)).href === import.meta.url;
}

async function main(): Promise<void> {
  const result = await runPtySmoke(parsePtySmokeArgs(process.argv.slice(2)));
  if (result.status === 'skipped') {
    process.stdout.write(`PTY smoke SKIP: ${stripTerminalControls(result.reason)}\n`);
    return;
  }
  process.stdout.write(
    `PTY smoke PASS: marker; viewport ${formatViewport(result.viewport)}; resize; clean exit; terminal restored\n`,
  );
}

function reportFailure(error: unknown): void {
  const message = error instanceof Error ? error.message : 'Unknown PTY smoke failure';
  process.stderr.write(`PTY smoke failed: ${stripTerminalControls(message)}\n`);
  process.exitCode = 1;
}

if (isDirectExecution()) void main().catch(reportFailure);
