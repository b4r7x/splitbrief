import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
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
  idle?: { warnMs: number; killMs: number } | undefined;
  signal?: AbortSignal | undefined;
  stdin?: string | undefined;
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
    'kills an idle child at the configured bound with the idle timeout as the first cause',
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
    'applies bounded grace then force kill when a child ignores SIGTERM',
    async () => {
      const dir = markerDir();
      const marker = join(dir, 'sigterm');
      const env = { ...process.env, LIFECYCLE_TEST_MARKER: marker };
      let pid = 0;
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
