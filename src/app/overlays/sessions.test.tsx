import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { SessionsPicker } from './sessions.js';
import { flushEffects, tick } from '#testing/helpers/ink.js';

let tmp: string;

// The picker renders what the store already holds — boot loads it, and a finished
// run refreshes it — so a fixture that writes a session also seeds the store.
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
  if (tmp) cleanupTempDir(tmp);
  sessionsStore.reset();
  configStore.reset();
  overlayStore.reset();
  routerStore.reset();
  sessionSelectStore.reset();
  terminalSizeStore.reset();
});

describe('SessionsPicker', () => {
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

    instance.stdin.write('interrupted');
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
      expect(current).toContain('stop the run on screen first');
    });

    expect(routerStore.get().screen).toBe('workflow');
    expect(overlayStore.get().active).toBe('sessions');

    instance.unmount();
    expect(sessionSelectStore.get().error).toBeNull();
  });

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
