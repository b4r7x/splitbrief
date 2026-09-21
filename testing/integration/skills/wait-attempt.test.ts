import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';

const SCRIPT = fileURLToPath(
  new URL('../../../skills/splitbrief-run/scripts/wait-attempt.sh', import.meta.url),
);

let run: string;

beforeEach(() => {
  run = createTempDir('wait-attempt');
});

afterEach(() => {
  cleanupTempDir(run);
});

function runWaiter(args: readonly string[]): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve) => {
    execFile('sh', [SCRIPT, ...args], { env: { PATH: '/usr/bin:/bin' } }, (error, stdout) => {
      if (error === null) {
        resolve({ stdout, code: 0 });
        return;
      }
      resolve({ stdout, code: typeof error.code === 'number' ? error.code : 1 });
    });
  });
}

function attemptPath(task: string, suffix: string): string {
  return join(run, task, `attempt-1.${suffix}`);
}

function spawnAttempt(task: string, script: string): { pid: number; exited: Promise<void> } {
  mkdirSync(join(run, task), { recursive: true });
  const child = spawn('sh', ['-c', script], { detached: true, stdio: 'ignore' });
  const { pid } = child;
  if (pid === undefined) throw new Error('failed to spawn the attempt child');
  writeFileSync(attemptPath(task, 'pid'), `${pid}\n`);
  const exited = new Promise<void>((resolve) => {
    child.on('exit', () => resolve());
  });
  return { pid, exited };
}

function attemptScript(task: string, body: string): string {
  return `{ ${body}; } > "${attemptPath(task, 'log')}" 2>&1; echo "exit=$?" > "${attemptPath(task, 'done')}"`;
}

async function readPidFile(path: string): Promise<number> {
  for (let i = 0; i < 100; i += 1) {
    const pid = existsSync(path)
      ? Number.parseInt(readFileSync(path, 'utf8').trim(), 10)
      : Number.NaN;
    if (Number.isInteger(pid) && pid > 0) return pid;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`no pid was written to ${path}`);
}

async function waitUntilGone(pid: number): Promise<boolean> {
  for (let i = 0; i < 100; i += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

describe('wait-attempt.sh', { timeout: 60_000 }, () => {
  it('reports exit 0 and appends the line to events.log', async () => {
    spawnAttempt('T001', attemptScript('T001', 'sleep 1; printf "all good\\n"'));

    const { stdout, code } = await runWaiter([run, 'T001', '1']);

    expect(stdout).toBe('T001 attempt 1: exit=0\n');
    expect(code).toBe(0);
    expect(readFileSync(join(run, 'events.log'), 'utf8')).toBe('T001 attempt 1: exit=0\n');
  });

  it('reports exit 1', async () => {
    const { exited } = spawnAttempt('T002', attemptScript('T002', 'false'));
    await exited;

    const { stdout } = await runWaiter([run, 'T002', '1']);

    expect(stdout).toBe('T002 attempt 1: exit=1\n');
  });

  it('times out at --deadline 2, kills the group and writes exit=timeout', async () => {
    const childPidFile = join(run, 'grandchild.pid');
    const { exited } = spawnAttempt(
      'T003',
      `sleep 30 & printf '%s\\n' "$!" > "${childPidFile}"; wait`,
    );
    const grandchild = await readPidFile(childPidFile);

    const { stdout, code } = await runWaiter([run, 'T003', '1', '--deadline', '2']);
    await exited;

    expect(stdout).toBe('T003 attempt 1: timeout\n');
    expect(code).toBe(0);
    expect(readFileSync(attemptPath('T003', 'done'), 'utf8')).toBe('exit=timeout\n');
    expect(await waitUntilGone(grandchild)).toBe(true);
  });

  it('returns at once when a .done already exists', async () => {
    mkdirSync(join(run, 'T004'), { recursive: true });
    writeFileSync(attemptPath('T004', 'pid'), '999999\n');
    writeFileSync(attemptPath('T004', 'done'), 'exit=0\n');

    const started = Date.now();
    const { stdout } = await runWaiter([run, 'T004', '1']);

    expect(stdout).toBe('T004 attempt 1: exit=0\n');
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('exits 2 when the pid file is missing', async () => {
    const { stdout, code } = await runWaiter([run, 'T005', '1']);

    expect(stdout).toBe('T005 attempt 1: missing-pid\n');
    expect(code).toBe(2);
  });

  it('appends halt=auth when the log tail carries a halt phrase', async () => {
    const { exited } = spawnAttempt(
      'T006',
      attemptScript('T006', 'printf "Invalid API key\\n"; false'),
    );
    await exited;

    const { stdout } = await runWaiter([run, 'T006', '1']);

    expect(stdout).toBe('T006 attempt 1: exit=1 halt=auth\n');
  });

  it('--reconcile reports done, dead and alive rows', async () => {
    writeFileSync(
      join(run, 'progress.md'),
      [
        '| ID | Brief | State |',
        '| --- | --- | --- |',
        '| T001 | first | done |',
        '| T002 | second | running |',
        '| T003 | third | running |',
        '| T004 | fourth | running |',
        '',
      ].join('\n'),
    );
    mkdirSync(join(run, 'T002'), { recursive: true });
    writeFileSync(attemptPath('T002', 'pid'), '999999\n');
    writeFileSync(attemptPath('T002', 'done'), 'exit=0\n');
    const dead = spawnAttempt('T003', 'true');
    await dead.exited;
    const alive = spawnAttempt('T004', 'sleep 30');

    const { stdout, code } = await runWaiter(['--reconcile', run]);
    process.kill(alive.pid);
    await alive.exited;

    expect(stdout).toBe(`T002: done exit=0\nT003: dead no-done\nT004: alive pid=${alive.pid}\n`);
    expect(code).toBe(0);
  });
});
