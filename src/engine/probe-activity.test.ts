import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const STARTED_AT = 1_786_000_000_000;

let activity: typeof import('./probe-activity.js');

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(STARTED_AT);
  vi.resetModules();
  activity = await import('./probe-activity.js');
});

afterEach(() => {
  vi.useRealTimers();
});

describe('probe activity', () => {
  it('lists a running probe until it settles and keeps one snapshot between changes', async () => {
    const empty = activity.probeActivitySnapshot();
    expect(empty).toEqual({ probes: [], tools: [] });
    expect(activity.probeActivitySnapshot()).toBe(empty);
    let changes = 0;
    const unsubscribe = activity.subscribeProbeActivity(() => {
      changes += 1;
    });

    const signIn = Promise.withResolvers<string>();
    const version = Promise.withResolvers<string>();
    const signInRun = activity.trackProbe(
      { tool: 'opencode', check: 'sign-in' },
      () => signIn.promise,
    );
    vi.setSystemTime(STARTED_AT + 2_000);
    const versionRun = activity.trackProbe(
      { tool: 'opencode', check: 'version' },
      () => version.promise,
    );

    const running = activity.probeActivitySnapshot();
    expect(running).not.toBe(empty);
    expect(Object.isFrozen(running)).toBe(true);
    expect(activity.probeActivitySnapshot()).toBe(running);
    expect(running.probes).toHaveLength(2);
    expect(running.probes).toEqual(
      expect.arrayContaining([
        { id: expect.any(Number), tool: 'opencode', check: 'sign-in', startedAt: STARTED_AT },
        {
          id: expect.any(Number),
          tool: 'opencode',
          check: 'version',
          startedAt: STARTED_AT + 2_000,
        },
      ]),
    );
    expect(new Set(running.probes.map((entry) => entry.id)).size).toBe(2);
    const heardWhileRunning = changes;
    expect(heardWhileRunning).toBeGreaterThan(0);

    signIn.resolve('signed in');
    await expect(signInRun).resolves.toBe('signed in');
    const oneLeft = activity.probeActivitySnapshot();
    expect(oneLeft).not.toBe(running);
    expect(oneLeft.probes.map((entry) => entry.check)).toEqual(['version']);

    version.resolve('1.0.0');
    await expect(versionRun).resolves.toBe('1.0.0');
    expect(activity.probeActivitySnapshot()).toEqual({ probes: [], tools: [] });
    const heardAfterSettling = changes;
    expect(heardAfterSettling).toBeGreaterThan(heardWhileRunning);

    unsubscribe();
    await activity.trackProbe({ tool: 'codex', check: 'version' }, async () => 'quiet');
    expect(changes).toBe(heardAfterSettling);
  });

  it('takes a probe off the list when its run rejects, and passes the rejection on', async () => {
    const failure = new Error('spawn failed');

    await expect(
      activity.trackProbe({ tool: 'codex', check: 'version' }, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);

    expect(activity.probeActivitySnapshot().probes).toEqual([]);
  });

  it('shows a tool as checking while any of its checks runs, and checked after the last one', async () => {
    const first = Promise.withResolvers<void>();
    const second = Promise.withResolvers<void>();
    const firstCheck = activity.trackToolCheck('opencode', () => first.promise);
    const secondCheck = activity.trackToolCheck('opencode', () => second.promise);
    expect(activity.probeActivitySnapshot().tools).toEqual([
      { tool: 'opencode', state: 'checking' },
    ]);

    first.resolve();
    await firstCheck;
    expect(activity.probeActivitySnapshot().tools).toEqual([
      { tool: 'opencode', state: 'checking' },
    ]);

    second.resolve();
    await secondCheck;
    const checked = activity.probeActivitySnapshot();
    expect(checked.tools).toEqual([{ tool: 'opencode', state: 'checked' }]);
    expect(activity.probeActivitySnapshot()).toBe(checked);

    const again = Promise.withResolvers<void>();
    const againCheck = activity.trackToolCheck('opencode', () => again.promise);
    expect(activity.probeActivitySnapshot().tools).toEqual([
      { tool: 'opencode', state: 'checking' },
    ]);
    const aborted = new Error('aborted');
    again.reject(aborted);
    await expect(againCheck).rejects.toBe(aborted);
    expect(activity.probeActivitySnapshot().tools).toEqual([
      { tool: 'opencode', state: 'checked' },
    ]);
  });
});
