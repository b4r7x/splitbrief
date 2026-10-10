import type { SpawnStdinWriter } from './lifecycle.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { processError } from '../errors.js';
import { killAllProcesses, SIGKILL_DELAY_MS } from '../registry.js';
import {
  isFatalSignal,
  spawnPipe,
  spawnPipeError,
  type SpawnPipeFatalSignal,
} from './lifecycle.js';

const itUnix = process.platform === 'win32' ? it.skip : it;

function processIsAbsent(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

const silent = 'setInterval(()=>{},1000)';

// Holds this event loop, and with it the parent's first stdin write, until the
// child is a zombie: proof that it quit before it could read anything.
function blockUntilExited(pid: number): void {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const stat = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' });
    if (stat.trim().startsWith('Z')) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
  throw new Error(`child ${pid} did not exit`);
}

function pipe(opts: {
  script: string;
  env?: NodeJS.ProcessEnv | undefined;
  idle?:
    | {
        warnMs: number;
        killMs?: number | undefined;
        onWarn?: ((silentMs: number) => void) | undefined;
        onClear?: (() => void) | undefined;
      }
    | undefined;
  signal?: AbortSignal | undefined;
  stdin?: string | undefined;
  stdinOptional?: boolean | undefined;
  onStdout?: (chunk: string) => SpawnPipeFatalSignal | undefined;
  onStderr?: (chunk: string) => undefined;
  onSpawned?: ((pid: number) => void) | undefined;
}) {
  return spawnPipe({
    command: process.execPath,
    args: ['-e', opts.script],
    cwd: tmpdir(),
    env: opts.env,
    detached: true,
    signal: opts.signal,
    idle: opts.idle,
    stdin: opts.stdin,
    stdinOptional: opts.stdinOptional,
    onStdout: opts.onStdout ?? (() => undefined),
    onStderr: opts.onStderr ?? (() => undefined),
    onSpawned: (proc) => {
      if (proc.pid !== undefined) opts.onSpawned?.(proc.pid);
    },
    onClose: (code, signal) => ({ code, signal }),
  });
}

const outputBudgetSignal: SpawnPipeFatalSignal = {
  state: 'output-budget-breach',
  remediation: 'fixture limit reached',
};

describe('spawnPipe lifecycle termination', () => {
  const dirs: string[] = [];
  function markerDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'splitbrief-lifecycle-'));
    dirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    await killAllProcesses();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  itUnix('resolves a successful child and leaves no process behind', async () => {
    let pid = 0;
    const result = await pipe({
      script: "process.stdout.write('ok')",
      onSpawned: (spawnedPid) => {
        pid = spawnedPid;
      },
    });

    expect(result).toEqual({ code: 0, signal: null });
    expect(pid).toBeGreaterThan(1);
    expect(processIsAbsent(pid)).toBe(true);
  });

  itUnix('refuses to spawn when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    let spawned = false;

    await expect(
      pipe({
        script: silent,
        signal: controller.signal,
        onSpawned: () => {
          spawned = true;
        },
      }),
    ).rejects.toBe(controller.signal.reason);
    expect(spawned).toBe(false);
  });

  itUnix('aborts the process group and preserves the abort reason as the rejection', async () => {
    const controller = new AbortController();
    let pid = 0;
    const pending = pipe({
      script: silent,
      signal: controller.signal,
      onSpawned: (spawnedPid) => {
        pid = spawnedPid;
        controller.abort(new DOMException('user cancelled', 'AbortError'));
      },
    });

    await expect(pending).rejects.toMatchObject({ name: 'AbortError', message: 'user cancelled' });
    expect(pid).toBeGreaterThan(1);
    expect(processIsAbsent(pid)).toBe(true);
  });

  itUnix(
    'kills a silent leader with no running child at the configured bound with the idle timeout as the first cause',
    async () => {
      let pid = 0;
      await expect(
        pipe({
          script: silent,
          idle: { warnMs: 20, killMs: 60 },
          onSpawned: (spawnedPid) => {
            pid = spawnedPid;
          },
        }),
      ).rejects.toSatisfy(processError.isIdleTimeout);

      expect(pid).toBeGreaterThan(1);
      expect(processIsAbsent(pid)).toBe(true);
    },
  );

  itUnix(
    'only warns a silent leader when no kill bound is set, and clears the warning on output',
    async () => {
      const dir = markerDir();
      const go = join(dir, 'go');
      const controller = new AbortController();
      let warnings = 0;
      let clears = 0;
      let settled = false;
      const pending = pipe({
        script: [
          "const fs=require('node:fs')",
          `const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(go)})){clearInterval(t);process.stdout.write('back');setInterval(()=>{},1000)}},10)`,
        ].join(';'),
        idle: {
          warnMs: 50,
          onWarn: () => {
            warnings += 1;
          },
          onClear: () => {
            clears += 1;
          },
        },
        signal: controller.signal,
      });
      pending.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );

      await vi.waitFor(() => expect(warnings).toBe(1), { timeout: 5_000, interval: 10 });
      // Several warn windows pass in silence: one warning, and no cut.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(warnings).toBe(1);
      expect(clears).toBe(0);
      expect(settled).toBe(false);

      writeFileSync(go, '');
      await vi.waitFor(() => expect(clears).toBe(1), { timeout: 5_000, interval: 10 });
      expect(settled).toBe(false);

      controller.abort(new DOMException('test finished', 'AbortError'));
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    },
    15_000,
  );

  itUnix(
    'cuts a silent leader with a running child at the kill bound and reaps the child',
    async () => {
      const dir = markerDir();
      const pidFile = join(dir, 'child.pid');
      let leaderPid = 0;
      const pending = pipe({
        script: [
          "const {spawn}=require('node:child_process')",
          "const child=spawn('sleep',['30'],{stdio:'ignore'})",
          `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(child.pid))`,
          'setInterval(()=>{},1000)',
        ].join(';'),
        // The window also covers the leader's own Node start-up, which a
        // loaded machine stretches past a few hundred milliseconds.
        idle: { warnMs: 100, killMs: 1_000 },
        onSpawned: (spawnedPid) => {
          leaderPid = spawnedPid;
        },
      });

      await expect(pending).rejects.toSatisfy(processError.isIdleTimeout);
      const childPid = Number.parseInt(readFileSync(pidFile, 'utf8'), 10);
      expect(leaderPid).toBeGreaterThan(1);
      expect(childPid).toBeGreaterThan(1);
      expect(processIsAbsent(leaderPid)).toBe(true);
      expect(processIsAbsent(childPid)).toBe(true);
    },
    15_000,
  );

  itUnix(
    'resets the warn and kill timers on every output chunk',
    async () => {
      let warnings = 0;
      let output = '';
      // Output every 150 ms for 2.25 s, then silence: the call outlives two
      // kill bounds while it speaks and is cut only once it falls silent.
      const startedAt = performance.now();
      const pending = pipe({
        script:
          "let n=0;const t=setInterval(()=>{process.stdout.write('.');if(++n===15)clearInterval(t)},150);setInterval(()=>{},1000)",
        idle: {
          warnMs: 500,
          killMs: 1_000,
          onWarn: () => {
            warnings += 1;
          },
        },
        onStdout: (chunk) => {
          output += chunk;
          return undefined;
        },
      });

      await expect(pending).rejects.toSatisfy(processError.isIdleTimeout);
      expect(output).toBe('.'.repeat(15));
      expect(performance.now() - startedAt).toBeGreaterThanOrEqual(2_250);
      expect(warnings).toBe(1);
    },
    15_000,
  );

  itUnix(
    'applies bounded grace then force kill when a child ignores SIGTERM',
    async () => {
      const dir = markerDir();
      const marker = join(dir, 'sigterm');
      const env = { ...process.env, LIFECYCLE_TEST_MARKER: marker };
      let pid = 0;
      // Only the grace deadline runs on the fake clock: the signals, the exit
      // and the absence polling stay real.
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const signals = vi.spyOn(process, 'kill');
      const pending = pipe({
        script: [
          "require('node:fs').writeFileSync(process.env.LIFECYCLE_TEST_MARKER,'sigterm')",
          "process.on('SIGTERM',()=>{})",
          "process.stdout.write('started')",
          'setInterval(()=>{},1000)',
        ].join(';'),
        env,
        onStdout: () => outputBudgetSignal,
        onSpawned: (spawnedPid) => {
          pid = spawnedPid;
        },
      });

      const settled = pending.catch((err: unknown) => err);
      try {
        await vi.waitFor(() => expect(signals).toHaveBeenCalledWith(-pid, 'SIGTERM'));
        await vi.advanceTimersByTimeAsync(SIGKILL_DELAY_MS);
        await settled;
        expect(signals).toHaveBeenCalledWith(-pid, 'SIGKILL');
      } finally {
        signals.mockRestore();
        vi.useRealTimers();
      }
      await expect(pending).rejects.toSatisfy(isFatalSignal);
      expect(pid).toBeGreaterThan(1);
      expect(processIsAbsent(pid)).toBe(true);
      expect(existsSync(marker)).toBe(true);
    },
    15_000,
  );

  itUnix('reaps the whole process group when a fatal output signal fires', async () => {
    let leaderPid = 0;
    let descendantPid = 0;
    const pending = pipe({
      script: [
        "const {spawn}=require('node:child_process')",
        "const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'})",
        "process.stdout.write('pid:'+child.pid)",
        'setInterval(()=>{},1000)',
      ].join(';'),
      onStdout: (chunk) => {
        descendantPid = Number.parseInt(chunk.slice(chunk.indexOf(':') + 1), 10);
        return outputBudgetSignal;
      },
      onSpawned: (spawnedPid) => {
        leaderPid = spawnedPid;
      },
    });

    await expect(pending).rejects.toMatchObject({ state: 'output-budget-breach' });
    expect(leaderPid).toBeGreaterThan(1);
    expect(descendantPid).toBeGreaterThan(1);
    expect(processIsAbsent(leaderPid)).toBe(true);
    expect(processIsAbsent(descendantPid)).toBe(true);
  });

  itUnix('settles once and keeps the first fatal signal as the cause', async () => {
    let pid = 0;
    let stdoutChunks = 0;
    const pending = pipe({
      script: [
        "process.stdout.write('first')",
        "process.stdout.write('second')",
        'setInterval(()=>{},1000)',
      ].join(';'),
      onStdout: () => {
        stdoutChunks += 1;
        return stdoutChunks === 1
          ? outputBudgetSignal
          : { state: 'protocol-failure', remediation: 'later signal must not win' };
      },
      onSpawned: (spawnedPid) => {
        pid = spawnedPid;
      },
    });

    await expect(pending).rejects.toMatchObject({
      state: 'output-budget-breach',
      remediation: 'fixture limit reached',
    });
    expect(processIsAbsent(pid)).toBe(true);
  });
});

describe('spawnPipe stdin failure', () => {
  const limitLine = 'error: Individual quota reached. Resets in 2h6m30s.';
  const writeLimitAndExit = `require('node:fs').writeSync(2,${JSON.stringify(`${limitLine}\n`)});process.exit(1)`;

  afterEach(async () => {
    await killAllProcesses();
  });

  itUnix.each([
    { path: 'error event', mode: 'absent' },
    { path: 'error event', mode: 'optional' },
    { path: 'write callback', mode: 'optional' },
    { path: 'error event', mode: 'required' },
    { path: 'write callback', mode: 'required' },
  ])('handles ENOTCONN from the $path with $mode stdin', async ({ path, mode }) => {
    const stdinError = Object.assign(new Error('write ENOTCONN'), { code: 'ENOTCONN' });
    const pending = spawnPipe({
      command: process.execPath,
      args: ['-e', 'process.exit(0)'],
      detached: true,
      stdin: mode === 'absent' ? undefined : 'payload',
      stdinOptional: mode === 'optional',
      onStdout: () => undefined,
      onStderr: () => undefined,
      onClose: (code, signal) => ({ code, signal }),
      onSpawned: (proc) => {
        const stdin = proc.stdin;
        if (stdin === null) throw new Error('stdin unavailable');
        if (path === 'error event') {
          stdin.emit('error', stdinError);
        } else {
          vi.spyOn(stdin, 'write').mockImplementationOnce((_chunk, callback: unknown) => {
            if (typeof callback === 'function') callback(stdinError);
            return false;
          });
        }
      },
    });

    if (mode === 'required') {
      await expect(pending).rejects.toMatchObject({
        kind: 'process-stdin-incomplete',
        cause: stdinError,
      });
    } else {
      await expect(pending).resolves.toEqual({ code: 0, signal: null });
    }
  });

  itUnix.each([0, 7])(
    'preserves exit code %i when the child exits before the first optional stdin write',
    async (code) => {
      let pid = 0;
      const pending = pipe({
        script: `process.exit(${code})`,
        stdin: 'payload',
        stdinOptional: true,
        onSpawned: (spawnedPid) => {
          pid = spawnedPid;
          blockUntilExited(spawnedPid);
        },
      });

      await expect(pending).resolves.toEqual({ code, signal: null });
      expect(processIsAbsent(pid)).toBe(true);
    },
  );

  itUnix('delivers the stderr of a child that exits before the first stdin write', async () => {
    let pid = 0;
    let stderr = '';
    const pending = pipe({
      script: writeLimitAndExit,
      stdin: 'prompt',
      onStderr: (chunk) => {
        stderr += chunk;
      },
      onSpawned: (spawnedPid) => {
        pid = spawnedPid;
        blockUntilExited(spawnedPid);
      },
    });

    await expect(pending).rejects.toSatisfy(spawnPipeError.isStdinIncomplete);
    expect(stderr).toContain(limitLine);
    expect(processIsAbsent(pid)).toBe(true);
  });

  itUnix('kills a child that stays alive after it closes its stdin', async () => {
    let pid = 0;
    let stderr = '';
    const pending = pipe({
      script:
        "const fs=require('node:fs');fs.writeSync(2,'closing stdin\\n');fs.closeSync(0);setInterval(()=>{},1000)",
      stdin: 'x'.repeat(8 * 1024 * 1024),
      onStderr: (chunk) => {
        stderr += chunk;
      },
      onSpawned: (spawnedPid) => {
        pid = spawnedPid;
      },
    });

    await expect(pending).rejects.toSatisfy(spawnPipeError.isStdinIncomplete);
    expect(stderr).toContain('closing stdin');
    expect(processIsAbsent(pid)).toBe(true);
  });

  itUnix(
    'stops waiting for the close after the kill grace when a descendant holds stderr open',
    async () => {
      let stderr = '';
      let drainStartedAt = 0;
      const pending = pipe({
        script: [
          "const {spawn}=require('node:child_process')",
          "const holder=spawn(process.execPath,['-e','setTimeout(()=>{},10000)'],{detached:true,stdio:['ignore','ignore','inherit']})",
          "require('node:fs').writeSync(2,'holder:'+holder.pid+'\\n')",
          writeLimitAndExit,
        ].join(';'),
        stdin: 'prompt',
        onStderr: (chunk) => {
          stderr += chunk;
        },
        onSpawned: (spawnedPid) => {
          blockUntilExited(spawnedPid);
          drainStartedAt = performance.now();
        },
      });

      try {
        await expect(pending).rejects.toSatisfy(spawnPipeError.isStdinIncomplete);
        expect(performance.now() - drainStartedAt).toBeGreaterThanOrEqual(SIGKILL_DELAY_MS - 50);
        expect(stderr).toContain(limitLine);
      } finally {
        const holderPid = Number(/holder:(\d+)/.exec(stderr)?.[1]);
        if (holderPid > 1) process.kill(holderPid, 'SIGKILL');
      }
    },
    15_000,
  );

  itUnix('resolves a child that reads its whole prompt with every byte it wrote', async () => {
    let stdout = '';
    let stderr = '';
    const result = await pipe({
      script:
        "let v='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>v+=c);process.stdin.on('end',()=>{process.stdout.write(v);process.stderr.write('read')})",
      stdin: 'the prompt',
      onStdout: (chunk) => {
        stdout += chunk;
        return undefined;
      },
      onStderr: (chunk) => {
        stderr += chunk;
      },
    });

    expect(result).toEqual({ code: 0, signal: null });
    expect(stdout).toBe('the prompt');
    expect(stderr).toBe('read');
  });
});

describe('spawnPipe held stdin', () => {
  itUnix('fails an incomplete initial prompt while stdin is held and reaps the child', async () => {
    let pid = 0;
    const ready = vi.fn();
    await expect(
      spawnPipe({
        command: process.execPath,
        args: ['-e', "require('node:fs').closeSync(0);setTimeout(()=>process.exit(0),50)"],
        detached: true,
        stdin: 'x'.repeat(16 * 1024 * 1024),
        onStdinReady: ready,
        onSpawned: (proc) => {
          pid = proc.pid ?? 0;
        },
        onStdout: () => undefined,
        onStderr: () => undefined,
        onClose: (code) => code,
      }),
    ).rejects.toMatchObject({ kind: 'process-stdin-incomplete' });
    expect(ready).not.toHaveBeenCalled();
    expect(pid).toBeGreaterThan(1);
    expect(processIsAbsent(pid)).toBe(true);
  });

  itUnix('returns a real EPIPE to the follow-up writer and completes after reaping', async () => {
    let pid = 0;
    let writer: SpawnStdinWriter | undefined;
    let write: Promise<void> | undefined;
    let writeError: unknown;
    const result = await spawnPipe({
      command: process.execPath,
      args: [
        '-e',
        "process.stdin.once('data',()=>{process.stdin.once('close',()=>{console.log('closed');setTimeout(()=>process.exit(0),100)});process.stdin.destroy()})",
      ],
      detached: true,
      stdin: 'prompt',
      onStdinReady: (value) => {
        writer = value;
      },
      onSpawned: (proc) => {
        pid = proc.pid ?? 0;
      },
      onStdout: () => {
        if (writer === undefined) throw new Error('writer unavailable');
        write = writer.write('x'.repeat(16 * 1024 * 1024)).catch((cause) => {
          writeError = cause;
        });
        return undefined;
      },
      onStderr: () => undefined,
      onClose: (code) => code,
    });
    await write;
    expect(writeError).toMatchObject({ code: 'EPIPE' });
    expect(result).toBe(0);
    expect(pid).toBeGreaterThan(1);
    expect(processIsAbsent(pid)).toBe(true);
  });

  itUnix('writes the initial prompt and follow-up before the owner ends stdin', async () => {
    let output = '';
    const result = await spawnPipe({
      command: process.execPath,
      args: [
        '-e',
        "process.stdin.setEncoding('utf8');process.stdin.on('data',c=>process.stdout.write(c));process.stdin.on('end',()=>process.stdout.write('EOF'))",
      ],
      detached: true,
      stdin: 'prompt\n',
      onStdinReady: (writer) => {
        void writer.write('steer\n').then(() => writer.end());
      },
      onStdout: (chunk) => {
        output += chunk;
        return undefined;
      },
      onStderr: () => undefined,
      onClose: (code) => code,
    });
    expect(result).toBe(0);
    expect(output).toBe('prompt\nsteer\nEOF');
  });

  itUnix('allows exit with held stdin and rejects later writes only to the owner', async () => {
    let writer: SpawnStdinWriter | undefined;
    const result = await spawnPipe({
      command: process.execPath,
      args: ['-e', "process.stdin.once('data',()=>process.exit(0))"],
      detached: true,
      stdin: 'prompt',
      onStdinReady: (value) => {
        writer = value;
      },
      onStdout: () => undefined,
      onStderr: () => undefined,
      onClose: (code) => code,
    });
    expect(result).toBe(0);
    if (writer === undefined) throw new Error('writer unavailable');
    await expect(writer.write('late')).rejects.toBeInstanceOf(Error);
    writer.end();
  });
});
