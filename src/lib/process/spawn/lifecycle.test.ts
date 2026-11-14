import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnPipe } from './lifecycle.js';
import type { SpawnPipeOptions } from './types.js';

const h = vi.hoisted(() => ({
  log: [] as string[],
  proc: undefined as unknown,
  kill: Promise.withResolvers<void>(),
  abort: Promise.withResolvers<void>(),
  stdinWrite: undefined as ((err?: Error | null) => void) | undefined,
  stdinEnd: undefined as (() => void) | undefined,
}));

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: () => {
    h.log.push('spawn');
    return h.proc;
  },
}));

vi.mock('../registry.js', () => ({
  registerProcess: () => h.log.push('register'),
  unregisterProcess: () => h.log.push('unregister'),
  killProcess: () => {
    h.log.push('kill');
    return h.kill.promise;
  },
  abortProcess: () => {
    h.log.push('abortProcess');
    return h.abort.promise;
  },
  processTreeReapingLimitation: () => new Error('no tree reaping'),
}));

function outputStream(name: string) {
  return Object.assign(new EventEmitter(), {
    setEncoding: () => undefined,
    pause: () => h.log.push(`${name}.pause`),
  });
}

function fakeProc() {
  const stdin = Object.assign(new EventEmitter(), {
    destroyed: false,
    writableEnded: false,
    write: (text: string, done: (err?: Error | null) => void) => {
      h.log.push(`stdin.write ${text} timers=${vi.getTimerCount()}`);
      h.stdinWrite = done;
      return true;
    },
    end: (done: () => void) => {
      h.log.push('stdin.end');
      h.stdinEnd = done;
    },
  });
  return Object.assign(new EventEmitter(), {
    pid: 4242,
    stdout: outputStream('stdout'),
    stderr: outputStream('stderr'),
    stdin,
  });
}

function pipe(options: Partial<SpawnPipeOptions<string>> = {}): Promise<number> {
  return spawnPipe<string>({
    command: 'tool',
    args: [],
    detached: true,
    onStdout: (chunk) => {
      h.log.push(`onStdout ${chunk}`);
      return undefined;
    },
    onStderr: () => undefined,
    onClose: (code) => {
      h.log.push(`onClose ${code} timers=${vi.getTimerCount()}`);
      return 'closed';
    },
    ...options,
  }).then(
    (value) => h.log.push(`resolve ${value}`),
    (err: unknown) =>
      h.log.push(
        err instanceof Error
          ? `reject ${err.message}${'data' in err ? ` ${JSON.stringify(err.data)}` : ''}`
          : `reject ${JSON.stringify(err, ['state', 'stdout'])}`,
      ),
  );
}

let proc: ReturnType<typeof fakeProc>;

beforeEach(() => {
  vi.useFakeTimers();
  h.log.length = 0;
  h.kill = Promise.withResolvers<void>();
  h.abort = Promise.withResolvers<void>();
  h.stdinWrite = undefined;
  h.stdinEnd = undefined;
  proc = fakeProc();
  h.proc = proc;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('spawnPipe step and dispose order', () => {
  it('starts in order: register, onSpawned, the idle timers, then the prompt write and end', async () => {
    const run = pipe({
      stdin: 'prompt',
      idle: { warnMs: 100, killMs: 200 },
      onSpawned: () => h.log.push(`onSpawned timers=${vi.getTimerCount()}`),
    });

    expect(h.log).toEqual([
      'spawn',
      'register',
      'onSpawned timers=0',
      'stdin.write prompt timers=2',
      'stdin.end',
    ]);
    h.stdinWrite?.();
    h.stdinEnd?.();
    proc.emit('close', 0, null);
    await run;
  });

  it('settles a clean close in order: idle timers cleared, unregister, onClose, resolve', async () => {
    const run = pipe({ idle: { warnMs: 100, killMs: 200 } });
    h.stdinEnd?.();
    h.log.length = 0;

    proc.emit('close', 0, null);
    await run;

    expect(h.log).toEqual(['unregister', 'onClose 0 timers=0', 'resolve closed']);
  });

  it('hands a chunk to its callback before the output budget stops the child', async () => {
    const run = pipe({ outputBudgetBytes: 4 });
    h.log.length = 0;

    proc.stdout.emit('data', 'abcdef');
    h.kill.resolve();
    await run;

    expect(h.log).toEqual([
      'onStdout abcdef',
      'stdout.pause',
      'stderr.pause',
      'kill',
      'unregister',
      'reject {"state":"output-budget-breach","stdout":"abcdef"}',
    ]);
  });

  it('keeps a failed kill as the cause and leaves the child registered', async () => {
    const run = pipe({ onStdout: () => ({ state: 'protocol-failure', remediation: 'bad line' }) });
    h.log.length = 0;

    proc.stdout.emit('data', 'line');
    h.kill.reject(new Error('the tree was not reaped'));
    await run;

    expect(h.log).toEqual([
      'stdout.pause',
      'stderr.pause',
      'kill',
      'reject the tree was not reaped',
    ]);
  });

  it('aborts in order: streams paused, the group aborted, unregister, reject with the reason', async () => {
    const controller = new AbortController();
    const run = pipe({ signal: controller.signal });
    h.log.length = 0;

    controller.abort(new Error('stopped by the user'));
    h.abort.resolve();
    await run;

    expect(h.log).toEqual([
      'stdout.pause',
      'stderr.pause',
      'abortProcess',
      'unregister',
      'reject stopped by the user',
    ]);
  });

  it('removes the abort listener and clears the idle timers when it settles', async () => {
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener');
    const run = pipe({ signal: controller.signal, idle: { warnMs: 100, killMs: 200 } });
    h.stdinEnd?.();

    proc.emit('close', 0, null);
    await run;

    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears an idle warning before the next chunk reaches its callback', async () => {
    const run = pipe({
      idle: {
        warnMs: 100,
        onWarn: () => h.log.push('onWarn'),
        onClear: () => h.log.push('onClear'),
      },
    });
    h.log.length = 0;

    vi.advanceTimersByTime(100);
    proc.stdout.emit('data', 'back');

    expect(h.log).toEqual(['onWarn', 'onClear', 'onStdout back']);
    h.stdinEnd?.();
    proc.emit('close', 0, null);
    await run;
  });

  it('drains the output of a child that broke its prompt until it closes, then rejects', async () => {
    const run = pipe({ stdin: 'prompt' });
    h.log.length = 0;

    h.stdinWrite?.(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
    proc.stdout.emit('data', 'last words');
    h.kill.resolve();
    await vi.advanceTimersByTimeAsync(0);
    proc.emit('close', 1, null);
    await run;

    expect(h.log).toEqual([
      'kill',
      'onStdout last words',
      'unregister',
      'unregister',
      'reject Process stdin closed before all input was delivered {"code":1}',
    ]);
  });
});
