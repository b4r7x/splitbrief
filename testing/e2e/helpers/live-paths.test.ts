import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionDir } from '../../../src/core/paths.js';
import { readProcessStartTimeMs } from '../../../src/lib/process/start-time.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import {
  pollUntil,
  readProcessGroups,
  resolveLivePathsCrew,
  survivorsAfter,
  trackLiveRuns,
  watchRunnerLedgers,
} from './live-paths.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('live paths crew', () => {
  beforeEach(() => {
    for (const name of [
      'SPLITBRIEF_REAL_CLI_PLANNER',
      'SPLITBRIEF_REAL_CLI_IMPLEMENTER',
      'SPLITBRIEF_REAL_CLI_REVIEWER',
      'SPLITBRIEF_REAL_CLI_CLAUDE_CODE_MODEL',
      'SPLITBRIEF_REAL_CLI_OPENCODE_MODEL',
      'SPLITBRIEF_REAL_CLI_CODEX_MODEL',
    ]) {
      vi.stubEnv(name, undefined);
    }
  });

  it('defaults to Claude planning and reviewing on sonnet and OpenCode building', () => {
    expect(resolveLivePathsCrew()).toEqual({
      plan: { tool: 'claude-code', model: 'sonnet' },
      build: { tool: 'opencode', model: 'opencode-go/deepseek-v4.1-flash' },
      review: { tool: 'claude-code', model: 'sonnet' },
    });
  });

  it('takes a seat tool from its env, with that tool pin and the cost ceiling', () => {
    vi.stubEnv('SPLITBRIEF_REAL_CLI_REVIEWER', 'codex');
    vi.stubEnv('SPLITBRIEF_REAL_CLI_CODEX_MODEL', 'gpt-5.6-luna');
    vi.stubEnv('SPLITBRIEF_REAL_CLI_OPENCODE_MODEL', 'opencode-go/deepseek-v4-flash');
    const crew = resolveLivePathsCrew();
    expect(crew.review).toEqual({ tool: 'codex', model: 'gpt-5.6-luna' });
    expect(crew.build).toEqual({ tool: 'opencode', model: 'opencode-go/deepseek-v4-flash' });
    vi.stubEnv('SPLITBRIEF_REAL_CLI_CLAUDE_CODE_MODEL', 'opus');
    expect(() => resolveLivePathsCrew()).toThrow(/cost ceiling/);
  });
});

describe('tool process survivors', () => {
  it('reads the processes of each group from ps output', () => {
    const ps = ['    1     1', '  420   420', '  421   420', '  500   499', ''].join('\n');
    expect(readProcessGroups(ps)).toEqual(
      new Map([
        [1, [1]],
        [420, [420, 421]],
        [499, [500]],
      ]),
    );
  });

  it('reports a live group until it exits', async () => {
    const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
    const pid = child.pid;
    if (pid === undefined) throw new Error('sleep did not start');
    const exited = new Promise((resolve) => child.once('exit', resolve));
    const entry = { pid, startTimeMs: readProcessStartTimeMs(pid) };
    try {
      expect(await survivorsAfter([entry], 0)).toEqual([pid]);
      expect(
        await survivorsAfter([{ pid, startTimeMs: Date.now() - 3_600_000 }], 0),
        'a leader that started at another time leads a recycled group',
      ).toEqual([]);
    } finally {
      process.kill(-pid, 'SIGKILL');
    }
    await exited;
    expect(await survivorsAfter([entry], 2_000)).toEqual([]);
  });
});

describe('polling a live run', () => {
  it('stops polling once the run ends first', async () => {
    let probes = 0;
    const ended = delay(300).then(() => {
      throw new Error('the run ended');
    });
    await expect(
      pollUntil(
        () => {
          probes += 1;
          return null;
        },
        { ended, timeoutMs: 60_000, what: 'a probe' },
      ),
    ).rejects.toThrow('the run ended');
    const settled = probes;
    await delay(600);
    expect(probes).toBe(settled);
  });
});

describe('the runs of a live project', () => {
  it('aborts a run still going and waits for it to settle', async () => {
    const order: string[] = [];
    const { startRun, abortRuns } = trackLiveRuns(new AbortController());
    const run = startRun(async (signal) => {
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      await delay(50);
      order.push('run settled');
      throw signal.reason;
    });
    await abortRuns();
    order.push('teardown went on');
    expect(order).toEqual(['run settled', 'teardown went on']);
    await expect(run).rejects.toThrow('still going');
  });

  it('a failed ledger read aborts the runs and fails the stop', async () => {
    const projectDir = createTempDir('live-paths-watch');
    try {
      // A directory where the ledger file belongs fails the read with EISDIR.
      mkdirSync(join(sessionDir(projectDir, 'watched'), 'runner-pids.jsonl'), { recursive: true });
      const runs = new AbortController();
      const stop = watchRunnerLedgers(projectDir, runs);
      await vi.waitFor(() => expect(runs.signal.aborted).toBe(true));
      expect(stop).toThrow('the runner ledger watcher failed');
    } finally {
      cleanupTempDir(projectDir);
    }
  });
});
