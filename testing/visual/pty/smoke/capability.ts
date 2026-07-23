const NODE_PTY_PACKAGE = 'node-pty';

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
