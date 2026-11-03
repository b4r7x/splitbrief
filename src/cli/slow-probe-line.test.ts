import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __testResetProbeActivity, trackProbe } from '../engine/probe-activity.js';
import { holdSlowProbeLines, watchSlowProbeLines } from './slow-probe-line.js';

beforeEach(() => {
  vi.useFakeTimers();
  __testResetProbeActivity();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('watchSlowProbeLines', () => {
  it('writes one line for a probe once it has run ten seconds, and nothing for a quick one', async () => {
    const lines: string[] = [];
    const stop = watchSlowProbeLines((line) => lines.push(line));

    const quick = Promise.withResolvers<void>();
    const quickRun = trackProbe({ tool: 'codex', check: 'version' }, () => quick.promise);
    const signIn = Promise.withResolvers<void>();
    const signInRun = trackProbe({ tool: 'opencode', check: 'sign-in' }, () => signIn.promise);

    await vi.advanceTimersByTimeAsync(5_000);
    quick.resolve();
    await quickRun;

    await vi.advanceTimersByTimeAsync(4_999);
    expect(lines).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(lines).toEqual(['Checking tools · OpenCode CLI sign-in 10s']);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(lines).toEqual(['Checking tools · OpenCode CLI sign-in 10s']);

    signIn.resolve();
    await signInRun;
    stop();
  });

  it('writes nothing after it is stopped', async () => {
    const lines: string[] = [];
    const stop = watchSlowProbeLines((line) => lines.push(line));
    const models = Promise.withResolvers<void>();
    const modelsRun = trackProbe({ tool: 'kilo-code', check: 'model list' }, () => models.promise);

    await vi.advanceTimersByTimeAsync(9_000);
    stop();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(lines).toEqual([]);

    models.resolve();
    await modelsRun;
  });

  it('writes the line when its timer fires before the wall clock reaches ten seconds', async () => {
    const lines: string[] = [];
    const stop = watchSlowProbeLines((line) => lines.push(line));
    const signIn = Promise.withResolvers<void>();
    const signInRun = trackProbe({ tool: 'opencode', check: 'sign-in' }, () => signIn.promise);

    await vi.advanceTimersByTimeAsync(9_999);
    vi.setSystemTime(Date.now() - 1);
    await vi.advanceTimersByTimeAsync(1);
    expect(lines).toEqual(['Checking tools · OpenCode CLI sign-in 10s']);

    signIn.resolve();
    await signInRun;
    stop();
  });

  it('writes one line for two overlapping probes of one tool and check', async () => {
    const lines: string[] = [];
    const stop = watchSlowProbeLines((line) => lines.push(line));
    const gate = Promise.withResolvers<void>();
    const first = trackProbe({ tool: 'claude-code', check: 'version' }, () => gate.promise);
    await vi.advanceTimersByTimeAsync(50);
    const second = trackProbe({ tool: 'claude-code', check: 'version' }, () => gate.promise);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(lines).toEqual(['Checking tools · Claude Code CLI version 10s']);

    gate.resolve();
    await Promise.all([first, second]);
    stop();
  });

  it('writes its own line for a later probe of the same check after the first one ended', async () => {
    const lines: string[] = [];
    const stop = watchSlowProbeLines((line) => lines.push(line));
    const firstGate = Promise.withResolvers<void>();
    const first = trackProbe({ tool: 'claude-code', check: 'version' }, () => firstGate.promise);
    await vi.advanceTimersByTimeAsync(12_000);
    firstGate.resolve();
    await first;

    const secondGate = Promise.withResolvers<void>();
    const second = trackProbe({ tool: 'claude-code', check: 'version' }, () => secondGate.promise);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(lines).toEqual([
      'Checking tools · Claude Code CLI version 10s',
      'Checking tools · Claude Code CLI version 10s',
    ]);

    secondGate.resolve();
    await second;
    stop();
  });

  it('drops the line of a probe that crosses ten seconds during a hold, and writes the next one', async () => {
    const lines: string[] = [];
    const stop = watchSlowProbeLines((line) => lines.push(line));
    const release = holdSlowProbeLines();
    const heldGate = Promise.withResolvers<void>();
    const held = trackProbe({ tool: 'claude-code', check: 'version' }, () => heldGate.promise);

    await vi.advanceTimersByTimeAsync(11_000);
    expect(lines).toEqual([]);
    release();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(lines).toEqual([]);
    heldGate.resolve();
    await held;

    const nextGate = Promise.withResolvers<void>();
    const next = trackProbe({ tool: 'claude-code', check: 'version' }, () => nextGate.promise);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(lines).toEqual(['Checking tools · Claude Code CLI version 10s']);

    nextGate.resolve();
    await next;
    stop();
  });
});
