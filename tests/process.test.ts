import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runCommand, spawnWithStreaming, killProcess, isENOENT, getActiveProcessCount } from '../src/utils/process.js';
import { spawn } from 'node:child_process';

describe('runCommand', () => {
  it('resolves with stdout, stderr, and exit code', async () => {
    const result = await runCommand('echo', ['hello']);
    assert.equal(result.stdout.trim(), 'hello');
    assert.equal(result.code, 0);
  });

  it('rejects with error for nonexistent command (ENOENT) without leaking timer', async () => {
    // Before the fix, the timer was not cleared on spawn error, causing a leak.
    // The fix hoists the timer declaration and clears it in the error handler.
    await assert.rejects(
      () => runCommand('nonexistent-command-that-does-not-exist-xyz', []),
      (err: NodeJS.ErrnoException) => {
        assert.equal(err.code, 'ENOENT');
        return true;
      },
    );
    // After rejection, the process should be cleaned up from activeProcesses
    // (there's no reliable way to check the timer itself, but the process set
    // should not accumulate dead entries)
  });

  it('does not leave process in activeProcesses after completion', async () => {
    const sizeBefore = getActiveProcessCount();
    await runCommand('echo', ['test']);
    assert.equal(getActiveProcessCount(), sizeBefore);
  });

  it('does not leave process in activeProcesses after error', async () => {
    const sizeBefore = getActiveProcessCount();
    try {
      await runCommand('nonexistent-command-that-does-not-exist-xyz', []);
    } catch {}
    assert.equal(getActiveProcessCount(), sizeBefore);
  });

  it('ENOENT rejection completes quickly without dangling timer', async () => {
    const start = Date.now();
    try {
      await runCommand('nonexistent-command-that-does-not-exist-xyz', [], { timeout: 60_000 });
    } catch {}
    assert.ok(Date.now() - start < 3000);
  });

  it('captures stderr output', async () => {
    const result = await runCommand('node', ['-e', 'console.error("oops")']);
    assert.ok(result.stderr.includes('oops'));
    assert.equal(result.code, 0);
  });

  it('returns nonzero exit code on failure', async () => {
    const result = await runCommand('node', ['-e', 'process.exit(42)']);
    assert.equal(result.code, 42);
  });
});

describe('spawnWithStreaming', () => {
  it('streams stdout lines to callback', async () => {
    const lines: string[] = [];
    const result = await spawnWithStreaming('echo', ['line1'], (line) => lines.push(line));
    assert.equal(result.code, 0);
    assert.ok(lines.some((l) => l.includes('line1')));
  });

  it('cleans up from activeProcesses after completion', async () => {
    const sizeBefore = getActiveProcessCount();
    await spawnWithStreaming('echo', ['test'], () => {});
    assert.equal(getActiveProcessCount(), sizeBefore);
  });

  it('does not leave ghost entry in activeProcesses after ENOENT', async () => {
    const sizeBefore = getActiveProcessCount();
    try {
      await spawnWithStreaming('nonexistent-command-that-does-not-exist-xyz', [], () => {});
    } catch {}
    assert.equal(getActiveProcessCount(), sizeBefore);
  });
});

describe('killProcess', () => {
  it('kills a long-running process', async () => {
    const proc = spawn('sleep', ['60'], { stdio: 'ignore' });
    await new Promise<void>((resolve) => {
      proc.on('spawn', resolve);
    });
    assert.equal(proc.exitCode, null);
    killProcess(proc);
    await new Promise<void>((resolve) => {
      proc.on('close', () => resolve());
    });
    assert.ok(proc.killed);
  });
});

describe('isENOENT', () => {
  it('returns true for ENOENT errors', () => {
    const err = Object.assign(new Error('not found'), { code: 'ENOENT' });
    assert.equal(isENOENT(err), true);
  });

  it('returns false for other errors', () => {
    const err = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    assert.equal(isENOENT(err), false);
  });

  it('returns false for non-Error objects', () => {
    assert.equal(isENOENT('ENOENT'), false);
    assert.equal(isENOENT(null), false);
    assert.equal(isENOENT(undefined), false);
  });
});
