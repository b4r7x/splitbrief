import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
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

function writeSessionSummary(projectDir: string, session: Session): void {
  const dir = join(projectDir, SPLITBRIEF_DIR, 'sessions', session.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'summary.json'), JSON.stringify(session));
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
        status: 'interrupted',
        summary: null,
      }),
    );
    writeSessionSummary(
      tmp,
      makeSession({
        id: 'sess-beta',
        feature: 'refactor payments',
        status: 'interrupted',
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
        status: 'interrupted',
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
    writeSessionSummary(
      tmp,
      makeSession({
        id: 'sess-missing-state',
        feature: 'resume missing state',
        status: 'interrupted',
        summary: null,
      }),
    );

    overlayStore.open('sessions');
    const instance = render(<SessionsPicker />);
    await tick(1);
    await flushEffects();

    instance.stdin.write('\r');
    await vi.waitFor(() => {
      const current = instance.lastFrame() ?? '';
      expect(current).toContain('resume missing state');
      expect(current).toContain('saved workflow state');
    });

    const frame = instance.lastFrame() ?? '';
    expect(frame).not.toContain('Error:');
    expect(routerStore.get().screen).toBe('home');
    expect(overlayStore.get().active).toBe('sessions');

    instance.unmount();
    expect(sessionSelectStore.get().error).toBeNull();
  });

  it('reifies a rejected resume boundary without an unhandled event callback promise', async () => {
    const session = makeSession({
      id: 'sess-rejected-resume',
      feature: 'resume rejected boundary',
      status: 'interrupted',
      summary: null,
    });
    writeSessionSummary(tmp, session);
    overlayStore.open('sessions');
    const instance = render(
      <SessionsPicker
        deps={{
          loadState: () => ({ ...createInitialState(session.feature), phase: 'implementing' }),
          prepareResume: async () => {
            throw new Error('sessions overlay resume rejected');
          },
        }}
      />,
    );
    await tick(1);
    await flushEffects();

    instance.stdin.write('\r');
    await vi.waitFor(() => {
      expect(sessionSelectStore.get().preparation).toMatchObject({
        kind: 'failed',
        error: expect.objectContaining({ message: 'sessions overlay resume rejected' }),
      });
    });
    expect(routerStore.get().screen).toBe('home');
    expect(overlayStore.get().active).toBe('none');
    instance.unmount();
  });

  it('keeps long filter text visible at 80x18', async () => {
    terminalSizeStore.__testReset({ cols: 80, rows: 18, isSmall: true });
    writeSessionSummary(
      tmp,
      makeSession({
        id: 'sess-alpha',
        feature: 'alpha feature',
        status: 'interrupted',
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
    expect(frame).toContain('navigate');

    instance.unmount();
  });

  it('keeps title and hint visible when tiny terminals collapse the list', async () => {
    const terminalRows = 6;
    terminalSizeStore.__testReset({ cols: 80, rows: terminalRows, isSmall: true });
    writeSessionSummary(
      tmp,
      makeSession({
        id: 'sess-alpha',
        feature: 'alpha feature',
        status: 'interrupted',
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
    expect(frame.split('\n').length).toBeLessThanOrEqual(terminalRows);
    expect(stripAnsiStyles(frame)).toContain('Sessions · 1');
    expect(frame).toContain('navigate');
    expect(frame).not.toContain('No matching sessions');

    instance.unmount();
  });

  it('uses compact inline filtering at rows=10 when no list rows fit', async () => {
    const terminalRows = 10;
    terminalSizeStore.__testReset({ cols: 80, rows: terminalRows, isSmall: true });
    writeSessionSummary(
      tmp,
      makeSession({
        id: 'sess-alpha',
        feature: 'alpha feature',
        status: 'interrupted',
        summary: null,
      }),
    );

    const instance = render(<SessionsPicker />);
    await tick(1);
    await flushEffects();

    instance.stdin.write('alpha-feature-filter');
    await vi.waitFor(() => {
      const current = instance.lastFrame() ?? '';
      expect(stripAnsiStyles(current)).toContain('Sessions · 1');
      expect(current).toContain('alpha-feature');
    });

    const frame = instance.lastFrame() ?? '';
    expect(frame.split('\n').length).toBeLessThanOrEqual(terminalRows);
    expect(frame).toContain('navigate');
    expect(frame).not.toContain('No matching sessions');
    expect(frame).not.toContain('╭');
    expect(frame).not.toContain('╰');

    instance.unmount();
  });
});
