import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makePreparedExecution } from '#testing/helpers/factories/prepared-execution.js';
import { makeRunRecord } from '#testing/helpers/factories/run-record.js';
import { makeSession } from '#testing/helpers/factories/session.js';
import { SPLITBRIEF_DIR } from '../../core/paths.js';
import { sessionsStore } from '../../stores/project/sessions.js';
import { configStore } from '../../stores/project/config.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { routerStore } from '../../stores/navigation/router.js';
import { sessionSelectStore } from '../../stores/navigation/session-select.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import type { Session } from '../../core/schemas/session.js';
import { createInitialState } from '../../core/state/machine.js';
import {
  activeApply,
  trackActiveApply,
} from '../../engine/orchestrator/session-lifecycle/shutdown.js';
import { SessionsPicker } from './sessions.js';
import { flushEffects, renderFeature, tick } from '#testing/helpers/ink.js';

let tmp: string;

// Boot loads the store and the picker reads the list again whenever it opens; a fixture that
// writes a session also seeds the store, so a test reads what the run left on disk.
function writeSessionSummary(projectDir: string, session: Session): void {
  const dir = join(projectDir, SPLITBRIEF_DIR, 'sessions', session.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'summary.json'), JSON.stringify(session));
  sessionsStore.load(projectDir);
}

beforeEach(() => {
  tmp = createTempDir('sessions-picker-test');
  sessionsStore.reset();
  configStore.reset();
  overlayStore.reset();
  routerStore.reset();
  sessionSelectStore.reset();
  terminalSizeStore.reset();
  configStore.load(tmp);
});

afterEach(() => {
  vi.useRealTimers();
  if (tmp) cleanupTempDir(tmp);
  sessionsStore.reset();
  configStore.reset();
  overlayStore.reset();
  routerStore.reset();
  sessionSelectStore.reset();
  terminalSizeStore.reset();
});

describe('SessionsPicker', () => {
  it('reads the list again when it opens, so a run another process ended shows as ended', async () => {
    const session = makeSession({
      id: 'sess-ended',
      feature: 'add a word counter',
      status: 'open',
    });
    writeSessionSummary(tmp, session);
    expect(sessionsStore.get().sessions[0]?.status).toBe('open');
    // Another process closes the run after this one loaded its list.
    const dir = join(tmp, SPLITBRIEF_DIR, 'sessions', session.id);
    writeFileSync(join(dir, 'summary.json'), JSON.stringify({ ...session, status: 'ended' }));

    const instance = render(<SessionsPicker />);
    await tick(1);
    await tick(1);

    expect(sessionsStore.get().sessions[0]?.status).toBe('ended');
    expect(stripAnsiStyles(instance.lastFrame() ?? '')).toContain('ended');
    instance.unmount();
  });

  it('renders session feature names from disk once the store loads them', async () => {
    writeSessionSummary(
      tmp,
      makeSession({
        id: 'sess-alpha',
        feature: 'add authentication',
        status: 'open',
        summary: null,
      }),
    );
    writeSessionSummary(
      tmp,
      makeSession({
        id: 'sess-beta',
        feature: 'refactor payments',
        status: 'open',
        summary: null,
      }),
    );

    const instance = render(<SessionsPicker />);
    await tick(1);
    await tick(1);

    const frame = instance.lastFrame() ?? '';
    expect(frame).toContain('add authentication');
    expect(frame).toContain('refactor payments');
    expect(stripAnsiStyles(frame)).toContain('Sessions · 2');

    instance.unmount();
  });

  it('moves a row age on while the picker stays open, with no key pressed', async () => {
    const now = 1_700_000_000_000;
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(now);
    writeSessionSummary(tmp, makeSession({ id: 'sess-age', feature: 'ageing', startedAt: now }));

    const instance = render(<SessionsPicker />);
    await flushEffects();
    expect(stripAnsiStyles(instance.lastFrame() ?? '')).toContain('just now');

    vi.advanceTimersByTime(2 * 60_000);
    await flushEffects();
    expect(stripAnsiStyles(instance.lastFrame() ?? '')).toContain('2m ago');
    instance.unmount();
  });

  it('sheds whole legend keys instead of cutting one at 40 columns', async () => {
    terminalSizeStore.__testReset({ cols: 40, rows: 24, isSmall: true });

    const instance = render(<SessionsPicker />);
    await tick(1);

    const hintRow = stripAnsiStyles(instance.lastFrame() ?? '')
      .split('\n')
      .find((line) => line.includes('↑↓ select'))
      ?.replace(/[│|]/gu, '')
      .trim();
    expect(hintRow).toBe('↑↓ select · type filter');

    instance.unmount();
  });

  it('shows all sessions without a false more row when they fit the terminal', async () => {
    terminalSizeStore.__testReset({ cols: 100, rows: 32, isSmall: false });
    for (let i = 0; i < 6; i++) {
      writeSessionSummary(
        tmp,
        makeSession({
          id: `sess-${i}`,
          feature: `session feature ${i}`,
          status: 'complete',
        }),
      );
    }

    const instance = render(<SessionsPicker />);
    await tick(1);
    await tick(1);

    const frame = instance.lastFrame() ?? '';
    for (let i = 0; i < 6; i++) {
      expect(frame).toContain(`session feature ${i}`);
    }
    expect(frame).not.toContain('more');

    instance.unmount();
  });

  it('shows an empty-state hint when there are no sessions on disk', async () => {
    const instance = render(<SessionsPicker />);
    await tick(1);
    await tick(1);

    const frame = instance.lastFrame() ?? '';
    expect(stripAnsiStyles(frame)).toContain('Sessions · 0');
    expect(frame.toLowerCase()).toMatch(/no.*sessions/);

    instance.unmount();
  });

  it('filters sessions by status and id as well as feature text', async () => {
    writeSessionSummary(
      tmp,
      makeSession({
        id: 'sess-alpha-visible-id',
        feature: 'alpha feature',
        status: 'open',
        summary: null,
      }),
    );
    writeSessionSummary(
      tmp,
      makeSession({
        id: 'sess-beta-hidden-id',
        feature: 'beta feature',
        status: 'complete',
      }),
    );

    const instance = render(<SessionsPicker />);
    await tick(1);
    await flushEffects();

    instance.stdin.write('stopped');
    await vi.waitFor(() => {
      const current = instance.lastFrame() ?? '';
      expect(current).toContain('alpha feature');
      expect(current).not.toContain('beta feature');
    });

    instance.unmount();

    const byId = render(<SessionsPicker />);
    await tick(1);
    await flushEffects();

    byId.stdin.write('hidden-id');
    await vi.waitFor(() => {
      const current = byId.lastFrame() ?? '';
      expect(current).toContain('beta feature');
      expect(current).not.toContain('alpha feature');
    });

    byId.unmount();
  });

  it('keeps a selection error visible while the picker stays open', async () => {
    const running = makeSession({
      id: 'sess-running',
      feature: 'run already on screen',
      status: 'open',
      summary: null,
    });
    writeSessionSummary(tmp, running);
    routerStore.init({
      screen: 'workflow',
      run: makeRunRecord(),
      execution: {
        kind: 'local',
        prepared: makePreparedExecution({
          projectDir: tmp,
          sessionId: 'sess-local-run',
          feature: 'a local run',
          config: makeConfig(),
        }),
      },
    });

    overlayStore.open('sessions');
    const instance = render(<SessionsPicker />);
    await tick(1);
    await flushEffects();

    instance.stdin.write('\r');
    await vi.waitFor(() => {
      const current = instance.lastFrame() ?? '';
      expect(current).toContain('Stop the run on screen first.');
    });

    expect(routerStore.get().screen).toBe('workflow');
    expect(overlayStore.get().active).toBe('sessions');

    instance.unmount();
    expect(sessionSelectStore.get().error).toBeNull();
  });

  it('refuses to open another run while Apply writes the run on screen', async () => {
    writeSessionSummary(
      tmp,
      makeSession({ id: 'sess-other', feature: 'another run', status: 'open', summary: null }),
    );
    const onScreen = makeRunRecord({ status: { kind: 'running' } });
    routerStore.init({ screen: 'workflow', run: onScreen, execution: { kind: 'at-rest' } });
    const apply = Promise.withResolvers<void>();
    void trackActiveApply(apply.promise);
    onTestFinished(async () => {
      apply.resolve();
      await activeApply();
    });

    overlayStore.open('sessions');
    const instance = render(<SessionsPicker />);
    await tick(1);
    await flushEffects();

    instance.stdin.write('\r');
    await vi.waitFor(() => {
      expect(stripAnsiStyles(instance.lastFrame() ?? '')).toContain(
        'Apply is still writing to your checkout. Cannot open "another run".',
      );
    });
    const route = routerStore.get();
    expect(route.screen === 'workflow' && route.run).toBe(onScreen);
    expect(overlayStore.get().active).toBe('sessions');
    instance.unmount();
  });

  it.each([
    {
      refusal: 'the run on screen',
      reason: 'Stop the run on screen first.',
      onScreen: () =>
        routerStore.init({
          screen: 'workflow',
          run: makeRunRecord(),
          execution: {
            kind: 'local',
            prepared: makePreparedExecution({
              projectDir: tmp,
              sessionId: 'sess-local-run',
              feature: 'a local run',
              config: makeConfig(),
            }),
          },
        }),
      applying: false,
    },
    {
      refusal: 'Apply',
      reason: 'Apply is still writing to your checkout.',
      onScreen: () => {},
      applying: true,
    },
  ])(
    'shows the whole reason when $refusal refuses a pick of a long task at 140x45',
    async ({ reason, onScreen, applying }) => {
      terminalSizeStore.__testReset({ cols: 140, rows: 45, isSmall: false });
      writeSessionSummary(
        tmp,
        makeSession({
          id: 'sess-long',
          feature:
            'Add generated JSON data fixtures, as one task:\n\n- Add `scripts/gen-json.js` (CommonJS) that writes them',
          status: 'open',
          summary: null,
        }),
      );
      onScreen();
      overlayStore.open('sessions');
      const instance = renderFeature(
        <SessionsPicker
          deps={{
            applying: () => applying,
            hydrateRun: async () => {
              throw new Error('a refused pick opens nothing');
            },
            loadResumeState: () => ({ kind: 'missing' }),
            prepareResume: async () => {
              throw new Error('a refused pick prepares nothing');
            },
          }}
        />,
        { cols: 140, rows: 45 },
      );
      await tick(1);
      await flushEffects();

      instance.stdin.write('\r');
      await vi.waitFor(() => {
        expect(stripAnsiStyles(instance.lastFrame())).toContain(reason);
      });
      expect(sessionSelectStore.get().error).toBe(
        `${reason} Cannot open "Add generated JSON data fixtures, as one task: - Add \`scripts/gen-json.js\` (CommonJS) that writes them".`,
      );
      instance.unmount();
    },
  );

  it('opens the selected run at rest, replayed, without preparing anything', async () => {
    const session = makeSession({
      id: 'sess-open-at-rest',
      feature: 'open at rest',
      status: 'open',
      summary: null,
    });
    writeSessionSummary(tmp, session);
    overlayStore.open('sessions');
    const hydrateRun = vi.fn(async () => {});
    const instance = render(
      <SessionsPicker
        deps={{
          applying: () => false,
          hydrateRun,
          loadResumeState: () => ({
            kind: 'loaded',
            state: { ...createInitialState(session.feature), phase: 'implementing' },
          }),
          prepareResume: async () => {
            throw new Error('opening a run prepares nothing');
          },
        }}
      />,
    );
    await tick(1);
    await flushEffects();

    instance.stdin.write('\r');
    await vi.waitFor(() => {
      expect(routerStore.get().screen).toBe('workflow');
    });

    expect(hydrateRun).toHaveBeenCalledOnce();
    const route = routerStore.get();
    if (route.screen === 'workflow') expect(route.execution.kind).toBe('at-rest');
    expect(overlayStore.get().active).toBe('none');
    instance.unmount();
  });

  it.each([
    { rows: 18, compact: false },
    { rows: 10, compact: true },
    { rows: 6, compact: true },
  ])(
    'keeps the title, hint and long filter text visible at 80x$rows',
    async ({ rows, compact }) => {
      terminalSizeStore.__testReset({ cols: 80, rows, isSmall: true });
      writeSessionSummary(
        tmp,
        makeSession({
          id: 'sess-alpha',
          feature: 'alpha feature',
          status: 'open',
          summary: null,
        }),
      );

      const instance = render(<SessionsPicker />);
      await tick(1);
      await flushEffects();

      instance.stdin.write('alpha-feature-filter');
      await vi.waitFor(() => {
        expect(instance.lastFrame() ?? '').toContain('alpha-feature');
      });

      const frame = instance.lastFrame() ?? '';
      expect(stripAnsiStyles(frame)).toContain('Sessions · 1');
      expect(stripAnsiStyles(frame)).toContain('↑↓ select · type filter');
      if (compact) {
        expect(frame.split('\n').length).toBeLessThanOrEqual(rows);
        expect(frame).not.toContain('No matching sessions');
        expect(frame).not.toContain('╭');
        expect(frame).not.toContain('╰');
      }

      instance.unmount();
    },
  );
});
