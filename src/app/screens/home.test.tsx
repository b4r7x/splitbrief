import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  installClipboardExecFixture,
  readClipboardExecCalls,
  resetClipboardExecFixture,
  restoreClipboardExecFixture,
} from '#testing/helpers/clipboard-exec-fixture.js';
import { forceUnicodeGlyphs } from '#testing/helpers/glyphs.js';
import { flushEffects, renderFeature } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeSession } from '#testing/helpers/factories/session.js';
import { makeSummary } from '#testing/helpers/factories/summary.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { saveSummary } from '../../core/sessions/io.js';
import { saveState } from '../../core/state/persistence.js';
import { createInitialState } from '../../core/state/machine.js';
import { configStore } from '../../stores/project/config.js';
import { sessionsStore } from '../../stores/project/sessions.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { routerStore } from '../../stores/navigation/router.js';
import { inputHistoryStore } from '../../stores/ui/input-history.js';
import type { RuntimeCommandDef } from '../../core/runtime/commands/types.js';
import { getLogo } from '../../features/home/logo.js';
import { HomeScreen } from './home.js';

const originalPlatform = process.platform;

const CTRL_R = '\x12';
const ARROW_DOWN = '\u001b[B';
const ARROW_UP = '\u001b[A';
const ESC = '\u001b';
const ENTER = '\r';
const DEFAULT_HOME_HINT = '/help · /settings · /skills · ctrl+k commands';
const HOME_HINT = '/help · /settings · /skills · ctrl+r recent · ctrl+k commands';
const RECENT_SESSIONS_HINT = '↑↓ navigate · ⏎ open · y copy · esc back';
const FOCUS_BAR = '▌';
// Real session-file I/O (saveSummary + load/loadAll) can outlive vi.waitFor's 1s default
// under full-suite load; filter-settle polls need more headroom.
const SESSION_FILTER_WAIT_MS = 5000;

const COMMANDS: RuntimeCommandDef[] = [
  {
    kind: 'noarg',
    name: '/help',
    label: 'Help',
    description: 'Show help',
    validScreens: ['home'],
    handler: () => {},
  },
  {
    kind: 'arg',
    name: '/mode',
    label: 'Mode',
    description: 'Workflow mode',
    validScreens: ['home'],
    handler: () => {},
  },
];

function lineContaining(frame: string, text: string): string {
  const line = stripAnsiStyles(frame)
    .split('\n')
    .find((candidate) => candidate.includes(text));
  expect(line).toBeDefined();
  return line ?? '';
}

function expectLineContains(frame: string, anchor: string, text: string): void {
  const line = lineContaining(frame, anchor);
  expect(line).toContain(text);
}

function columnIndexOf(frame: string, text: string): number {
  return lineContaining(frame, text).indexOf(text);
}

describe('HomeScreen', () => {
  let projectDir = '';

  beforeEach(() => {
    forceUnicodeGlyphs();
    resetAllStores();
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    projectDir = createTempDir('home-screen-test');
    configStore.__testReset({ config: makeConfig(), projectDir });
  });

  afterEach(() => {
    resetAllStores();
    cleanupTempDir(projectDir);
    projectDir = '';
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  });

  it('centers the main content on wide terminals while keeping the input visible', async () => {
    terminalSizeStore.__testReset({ cols: 160, rows: 42, isSmall: false });

    const ui = renderFeature(<HomeScreen commands={COMMANDS} onRuntimeCommand={() => {}} />);
    await flushEffects();

    const frame = ui.lastFrame() ?? '';
    const plannerLine = frame.split('\n').find((line) => line.includes('Claude Code')) ?? '';
    expect(plannerLine.indexOf('Claude Code')).toBeGreaterThan(0);
    expect(frame).not.toContain('plan expensively · build cheaply');
    expect(frame).toContain(DEFAULT_HOME_HINT);
    ui.unmount();
  });

  it('keeps useful compact content on short terminals', async () => {
    terminalSizeStore.__testReset({ cols: 80, rows: 20, isSmall: true });

    const ui = renderFeature(<HomeScreen commands={COMMANDS} onRuntimeCommand={() => {}} />);
    await flushEffects();

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('|___/ .__/');
    expect(frame).toContain('standard');
    expect(frame).toContain('No recent sessions');
    ui.unmount();
  });

  it('renders slash suggestions with the docked input', async () => {
    terminalSizeStore.__testReset({ cols: 120, rows: 34, isSmall: false });

    const ui = renderFeature(<HomeScreen commands={COMMANDS} onRuntimeCommand={() => {}} />);
    await flushEffects();
    ui.stdin.write('/');
    await flushEffects();

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('/help');
    expect(frame).toContain('tab fill');
    ui.unmount();
  });

  it('keeps the config summary to one row with long configured model names', async () => {
    terminalSizeStore.__testReset({ cols: 100, rows: 30, isSmall: false });
    const longModel = 'provider-family-long';
    configStore.__testReset({
      projectDir,
      config: makeConfig({
        planner: { kind: 'cli', tool: 'codex', model: longModel },
        implementer: { model: longModel },
        workflow: { mode: 'standard' },
      }),
    });

    const ui = renderFeature(<HomeScreen commands={COMMANDS} onRuntimeCommand={() => {}} />);
    await flushEffects();

    const frame = ui.lastFrame() ?? '';
    const summaryLine = lineContaining(frame, 'Codex');
    expect(summaryLine).toBe(lineContaining(frame, 'standard'));
    expect(summaryLine).toContain('Ollama');
    expect(frame.split('\n').length).toBeLessThanOrEqual(30);
    ui.unmount();
  });

  it('caps recent sessions and reports a hidden count when capacity is tight', async () => {
    terminalSizeStore.__testReset({ cols: 80, rows: 18, isSmall: true });

    for (let i = 0; i < 25; i++) {
      saveSummary(
        { projectDir: projectDir, sessionId: `session-${i}` },
        makeSession({
          id: `session-${i}`,
          feature: `feature ${i}`,
          startedAt: 1_700_000_000 + i,
        }),
      );
    }

    const ui = renderFeature(<HomeScreen commands={COMMANDS} onRuntimeCommand={() => {}} />);
    await flushEffects();

    const frame = stripAnsiStyles(ui.lastFrame() ?? '');
    expect(frame).toContain('feature 24');
    expect(frame).toMatch(/\b\d+ more\b/);
    expect(frame).not.toContain('ctrl+r');
    ui.unmount();
  });

  it('shows recent sessions on short terminals', async () => {
    terminalSizeStore.__testReset({ cols: 80, rows: 18, isSmall: true });
    saveSummary(
      { projectDir: projectDir, sessionId: 'short-session' },
      makeSession({
        id: 'short-session',
        feature: 'short feature',
      }),
    );

    const ui = renderFeature(<HomeScreen commands={COMMANDS} onRuntimeCommand={() => {}} />);
    await flushEffects();

    expect(ui.lastFrame() ?? '').toContain('short feature');
    expect(sessionsStore.get().sessions.length).toBeGreaterThan(0);
    ui.unmount();
  });

  it('opens slash suggestions as an overlay while keeping centered content visible', async () => {
    terminalSizeStore.__testReset({ cols: 160, rows: 42, isSmall: false });

    const ui = renderFeature(<HomeScreen commands={COMMANDS} onRuntimeCommand={() => {}} />);
    await flushEffects();

    const before = ui.lastFrame() ?? '';
    const plannerLine = lineContaining(before, 'Claude Code');
    const modeLine = lineContaining(before, 'standard');

    ui.stdin.write('/');
    await flushEffects();

    const after = ui.lastFrame() ?? '';
    expect(after).toContain('tab fill');
    expect(lineContaining(after, 'Claude Code')).toBe(plannerLine);
    expect(lineContaining(after, 'standard')).toBe(modeLine);
    ui.unmount();
  });

  it('renders the full ASCII wordmark on large terminals', async () => {
    terminalSizeStore.__testReset({ cols: 120, rows: 30, isSmall: false });

    const ui = renderFeature(<HomeScreen commands={COMMANDS} onRuntimeCommand={() => {}} />);
    await flushEffects();

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('|____/| .__/');
    const renderedLogoLines = getLogo('full')
      .split('\n')
      .filter((line) => frame.includes(line.trim()));
    expect(renderedLogoLines.length).toBeGreaterThanOrEqual(5);
    ui.unmount();
  });

  it('renders compact ASCII art on small terminals', async () => {
    terminalSizeStore.__testReset({ cols: 80, rows: 15, isSmall: true });

    const ui = renderFeature(<HomeScreen commands={COMMANDS} onRuntimeCommand={() => {}} />);
    await flushEffects();

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('|___/ .__/');
    ui.unmount();
  });

  it('uses all safe vertical space before cutting recent sessions on tall terminals', async () => {
    terminalSizeStore.__testReset({ cols: 120, rows: 60, isSmall: false });

    for (let i = 0; i < 30; i++) {
      saveSummary(
        { projectDir: projectDir, sessionId: `session-${i}` },
        makeSession({
          id: `session-${i}`,
          feature: `tall feature ${i}`,
          startedAt: 1_700_000_000 + i,
        }),
      );
    }

    const ui = renderFeature(<HomeScreen commands={COMMANDS} onRuntimeCommand={() => {}} />);
    await flushEffects();

    const frame = ui.lastFrame() ?? '';
    const visibleCount = Array.from({ length: 30 }, (_, i) => `tall feature ${i}`).filter((label) =>
      frame.includes(label),
    ).length;
    expect(visibleCount).toBe(30);
    expect(frame).not.toMatch(/\b\d+ more\b/);
    expect(frame).toContain(HOME_HINT);
    expect(frame).toContain('›');
    ui.unmount();
  });

  it('renders logo and recent sessions within the terminal budget', async () => {
    const terminalRows = 30;
    terminalSizeStore.__testReset({ cols: 120, rows: terminalRows, isSmall: false });

    saveSummary(
      { projectDir: projectDir, sessionId: 'gap-session' },
      makeSession({
        id: 'gap-session',
        feature: 'gap test feature',
        startedAt: 1_700_000_000,
      }),
    );

    const ui = renderFeature(<HomeScreen commands={COMMANDS} onRuntimeCommand={() => {}} />);
    await flushEffects();

    const frame = ui.lastFrame() ?? '';
    expect(frame.split('\n').length).toBeLessThanOrEqual(terminalRows);
    expect(frame).toContain('|____/| .__/');
    expect(frame).toContain('gap test feature');
    expect(frame).toContain(HOME_HINT);
    ui.unmount();
  });
});

describe('HomeScreen recent-sessions focus (Ctrl+R navigation)', () => {
  let projectDir = '';

  function seedSessions(count: number): void {
    for (let i = 0; i < count; i++) {
      saveSummary(
        { projectDir, sessionId: `focus-session-${i}` },
        makeSession({
          id: `focus-session-${i}`,
          feature: `focus feature ${i}`,
          status: 'interrupted',
          summary: null,
          startedAt: 1_700_000_000 + i,
        }),
      );
    }
  }

  beforeEach(() => {
    forceUnicodeGlyphs();
    resetAllStores();
    installClipboardExecFixture();
    resetClipboardExecFixture();
    projectDir = createTempDir('home-focus-test');
    configStore.__testReset({ config: makeConfig(), projectDir });
    terminalSizeStore.__testReset({ cols: 120, rows: 60, isSmall: false });
  });

  afterEach(() => {
    resetAllStores();
    restoreClipboardExecFixture();
    cleanupTempDir(projectDir);
    projectDir = '';
  });

  it('Ctrl+R focuses the recent-sessions list', async () => {
    seedSessions(3);
    const ui = renderFeature(<HomeScreen commands={COMMANDS} onRuntimeCommand={() => {}} />);
    await flushEffects();

    expect(ui.lastFrame() ?? '').not.toContain(FOCUS_BAR);

    ui.stdin.write(CTRL_R);
    await flushEffects();

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain(FOCUS_BAR);
    expect(frame).toContain(RECENT_SESSIONS_HINT);
    ui.unmount();
  });

  it('preserves the composer draft and selected session across viable resize changes', async () => {
    terminalSizeStore.__testReset({ cols: 120, rows: 40, isSmall: false });
    seedSessions(3);
    const target = {
      id: 'focus-session-1',
      feature: 'focus feature 1',
    };
    saveState(
      { projectDir, sessionId: target.id },
      {
        ...createInitialState(target.feature),
        phase: 'implementing',
      },
    );
    const ui = renderFeature(<HomeScreen commands={COMMANDS} onRuntimeCommand={() => {}} />);
    await flushEffects();

    ui.stdin.write('preserved draft');
    await flushEffects();
    ui.stdin.write(CTRL_R);
    await vi.waitFor(() => {
      expect(ui.lastFrame() ?? '').toContain(FOCUS_BAR);
    }, SESSION_FILTER_WAIT_MS);
    ui.stdin.write(ARROW_DOWN);
    await vi.waitFor(() => {
      expectLineContains(ui.lastFrame() ?? '', target.feature, FOCUS_BAR);
    }, SESSION_FILTER_WAIT_MS);

    for (const viewport of [
      { cols: 80, rows: 24, isSmall: true },
      { cols: 120, rows: 40, isSmall: false },
    ]) {
      terminalSizeStore.__testReset(viewport);
      await flushEffects();

      const frame = ui.lastFrame() ?? '';
      expect(frame, `${viewport.cols}x${viewport.rows}`).toContain('preserved draft');
      expectLineContains(frame, target.feature, FOCUS_BAR);
      expect(frame.split('\n').length, `${viewport.cols}x${viewport.rows}`).toBeLessThanOrEqual(
        viewport.rows,
      );
    }

    ui.stdin.write(ENTER);
    await vi.waitFor(() => {
      expect(routerStore.get().screen).toBe('workflow');
    }, SESSION_FILTER_WAIT_MS);
    expect(routerStore.get()).toMatchObject({
      screen: 'workflow',
      feature: target.feature,
      sessionId: target.id,
    });
    ui.unmount();
  });

  it('engages the bordered focused recent-sessions chrome at a viable small height', async () => {
    terminalSizeStore.__testReset({ cols: 80, rows: 24, isSmall: true });
    seedSessions(30);
    const ui = renderFeature(<HomeScreen commands={COMMANDS} onRuntimeCommand={() => {}} />);
    await flushEffects();

    ui.stdin.write(CTRL_R);
    await vi.waitFor(() => {
      const frame = ui.lastFrame() ?? '';
      expect(frame).toContain('Recent sessions');
      expect(frame).toContain('Type to filter…');
      expect(frame).toContain(RECENT_SESSIONS_HINT);
      expect(frame).toContain(FOCUS_BAR);
    }, SESSION_FILTER_WAIT_MS);
    ui.unmount();
  });

  it('Ctrl+R is a no-op at 80x16 where the bordered filter cannot fit', async () => {
    terminalSizeStore.__testReset({ cols: 80, rows: 16, isSmall: true });
    seedSessions(30);
    const ui = renderFeature(<HomeScreen commands={COMMANDS} onRuntimeCommand={() => {}} />);
    await flushEffects();

    ui.stdin.write(CTRL_R);
    await flushEffects();

    const frame = ui.lastFrame() ?? '';
    expect(frame).not.toContain(FOCUS_BAR);
    expect(frame).not.toContain('Type to filter…');
    expect(frame).not.toContain('Recent sessions');
    ui.unmount();
  });

  it('Ctrl+R does not shift the recent-session rows horizontally', async () => {
    seedSessions(3);
    const marker = 'focus feature 1';
    const ui = renderFeature(<HomeScreen commands={COMMANDS} onRuntimeCommand={() => {}} />);
    await flushEffects();

    const before = columnIndexOf(ui.lastFrame() ?? '', marker);

    ui.stdin.write(CTRL_R);
    await flushEffects();

    const after = columnIndexOf(ui.lastFrame() ?? '', marker);
    expect(after).toBe(before);
    ui.unmount();
  });

  it('Ctrl+R is a no-op when there are no sessions', async () => {
    const ui = renderFeature(<HomeScreen commands={COMMANDS} onRuntimeCommand={() => {}} />);
    await flushEffects();

    ui.stdin.write(CTRL_R);
    await flushEffects();

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain(DEFAULT_HOME_HINT);
    expect(frame).not.toContain(FOCUS_BAR);
    ui.unmount();
  });

  it('Down moves the cursor to the next visible session', async () => {
    seedSessions(3);
    const ui = renderFeature(<HomeScreen commands={COMMANDS} onRuntimeCommand={() => {}} />);
    await flushEffects();

    ui.stdin.write(CTRL_R);
    await vi.waitFor(() => {
      expectLineContains(ui.lastFrame() ?? '', 'focus feature 2', FOCUS_BAR);
    }, SESSION_FILTER_WAIT_MS);
    await flushEffects();

    ui.stdin.write(ARROW_DOWN);
    await vi.waitFor(() => {
      expectLineContains(ui.lastFrame() ?? '', 'focus feature 1', FOCUS_BAR);
    }, SESSION_FILTER_WAIT_MS);
    ui.unmount();
  });

  it('Ctrl+R can filter beyond the unfocused preview budget', async () => {
    terminalSizeStore.__testReset({ cols: 120, rows: 30, isSmall: false });
    for (let i = 0; i < 35; i++) {
      saveSummary(
        { projectDir, sessionId: `focus-session-${i}` },
        makeSession({
          id: `focus-session-${i}`,
          feature: i === 0 ? 'ancient hidden focus target' : `focus feature ${i}`,
          status: 'interrupted',
          summary: null,
          startedAt: 1_700_000_000 + i,
        }),
      );
    }

    const ui = renderFeature(<HomeScreen commands={COMMANDS} onRuntimeCommand={() => {}} />);
    await flushEffects();

    expect(ui.lastFrame() ?? '').not.toContain('ancient hidden focus target');

    ui.stdin.write(CTRL_R);
    await vi.waitFor(() => {
      expect(ui.lastFrame() ?? '').toContain(FOCUS_BAR);
    }, SESSION_FILTER_WAIT_MS);
    await flushEffects();
    ui.stdin.write('ancient');
    await vi.waitFor(() => {
      const frame = ui.lastFrame() ?? '';
      expect(frame).toContain('ancient hidden focus target');
      expectLineContains(frame, 'ancient hidden focus target', FOCUS_BAR);
    }, SESSION_FILTER_WAIT_MS);

    ui.unmount();
  });

  it('Esc returns focus to the composer', async () => {
    seedSessions(3);
    const ui = renderFeature(<HomeScreen commands={COMMANDS} onRuntimeCommand={() => {}} />);
    await flushEffects();

    ui.stdin.write(CTRL_R);
    await vi.waitFor(() => {
      expect(ui.lastFrame() ?? '').toContain(FOCUS_BAR);
    }, SESSION_FILTER_WAIT_MS);
    await flushEffects();

    ui.stdin.write(ESC);
    await vi.waitFor(() => {
      const frame = ui.lastFrame() ?? '';
      expect(frame).not.toContain(FOCUS_BAR);
      expect(frame).toContain(HOME_HINT);
    }, SESSION_FILTER_WAIT_MS);
    ui.unmount();
  });

  it('Up at the top returns focus to the composer without wrapping', async () => {
    seedSessions(3);
    const ui = renderFeature(<HomeScreen commands={COMMANDS} onRuntimeCommand={() => {}} />);
    await flushEffects();

    ui.stdin.write(CTRL_R);
    await vi.waitFor(() => {
      expect(ui.lastFrame() ?? '').toContain(FOCUS_BAR);
    }, SESSION_FILTER_WAIT_MS);
    await flushEffects();

    ui.stdin.write(ARROW_UP);
    await vi.waitFor(() => {
      const frame = ui.lastFrame() ?? '';
      expect(frame).not.toContain(FOCUS_BAR);
      expect(frame).toContain(HOME_HINT);
    }, SESSION_FILTER_WAIT_MS);
    ui.unmount();
  });

  it('Enter with a filter that matches nothing selects no session', async () => {
    terminalSizeStore.__testReset({ cols: 80, rows: 24, isSmall: true });
    saveSummary(
      { projectDir, sessionId: 'invisible-complete' },
      makeSession({
        id: 'invisible-complete',
        feature: 'invisible feature',
        status: 'complete',
        summary: makeSummary({ feature: 'invisible feature' }),
        startedAt: 1_700_000_700,
      }),
    );

    const ui = renderFeature(<HomeScreen commands={COMMANDS} onRuntimeCommand={() => {}} />);
    await flushEffects();

    ui.stdin.write(CTRL_R);
    await vi.waitFor(() => {
      const frame = ui.lastFrame() ?? '';
      expect(frame).toContain('Type to filter…');
      expect(frame).toContain('invisible feature');
    }, SESSION_FILTER_WAIT_MS);
    await flushEffects();

    ui.stdin.write('zzznomatch');
    await vi.waitFor(() => {
      expect(ui.lastFrame() ?? '').not.toContain('invisible feature');
    }, SESSION_FILTER_WAIT_MS);

    ui.stdin.write(ENTER);
    await flushEffects();

    expect(routerStore.get().screen).toBe('home');
    ui.unmount();
  });

  it('y does not copy a session when the filtered list is empty', async () => {
    terminalSizeStore.__testReset({ cols: 80, rows: 24, isSmall: true });
    saveSummary(
      { projectDir, sessionId: 'invisible-copy' },
      makeSession({
        id: 'invisible-copy',
        feature: 'invisible copy feature',
        status: 'complete',
        summary: makeSummary({ feature: 'invisible copy feature' }),
        startedAt: 1_700_000_800,
      }),
    );

    const ui = renderFeature(<HomeScreen commands={COMMANDS} onRuntimeCommand={() => {}} />);
    await flushEffects();

    ui.stdin.write(CTRL_R);
    await vi.waitFor(() => {
      const frame = ui.lastFrame() ?? '';
      expect(frame).toContain('Type to filter…');
      expect(frame).toContain('invisible copy feature');
    }, SESSION_FILTER_WAIT_MS);
    await flushEffects();

    ui.stdin.write('zzznomatch');
    await vi.waitFor(() => {
      expect(ui.lastFrame() ?? '').not.toContain('invisible copy feature');
    }, SESSION_FILTER_WAIT_MS);

    ui.stdin.write('y');
    await flushEffects();

    expect(readClipboardExecCalls()).toHaveLength(0);
    ui.unmount();
  });

  it('Enter resumes an interrupted session into the workflow screen', async () => {
    saveSummary(
      { projectDir, sessionId: 'resume-me' },
      makeSession({
        id: 'resume-me',
        feature: 'resume feature',
        status: 'interrupted',
        summary: null,
        startedAt: 1_700_000_500,
      }),
    );
    const savedState = {
      ...createInitialState('resume feature'),
      phase: 'implementing' as const,
    };
    saveState({ projectDir, sessionId: 'resume-me' }, savedState);

    const ui = renderFeature(<HomeScreen commands={COMMANDS} onRuntimeCommand={() => {}} />);
    await flushEffects();

    ui.stdin.write(CTRL_R);
    await vi.waitFor(() => {
      expect(ui.lastFrame() ?? '').toContain(FOCUS_BAR);
    }, SESSION_FILTER_WAIT_MS);
    await flushEffects();
    ui.stdin.write(ENTER);
    await vi.waitFor(() => {
      expect(routerStore.get().screen).toBe('workflow');
    }, SESSION_FILTER_WAIT_MS);

    const route = routerStore.get();
    expect(route.screen).toBe('workflow');
    if (route.screen === 'workflow') {
      expect(route.sessionId).toBe('resume-me');
    }
    ui.unmount();
  });

  it('Enter opens a completed session summary from the recent-sessions list', async () => {
    const summary = makeSummary({ feature: 'completed feature' });
    saveSummary(
      { projectDir, sessionId: 'summary-me' },
      makeSession({
        id: 'summary-me',
        feature: 'completed feature',
        status: 'complete',
        summary,
        startedAt: 1_700_000_550,
      }),
    );

    const ui = renderFeature(<HomeScreen commands={COMMANDS} onRuntimeCommand={() => {}} />);
    await flushEffects();

    ui.stdin.write(CTRL_R);
    await vi.waitFor(() => {
      expect(ui.lastFrame() ?? '').toContain(FOCUS_BAR);
    }, SESSION_FILTER_WAIT_MS);
    await flushEffects();
    ui.stdin.write(ENTER);
    await vi.waitFor(() => {
      expect(routerStore.get().screen).toBe('summary');
    }, SESSION_FILTER_WAIT_MS);

    const route = routerStore.get();
    if (route.screen === 'summary') {
      expect(route.sessionId).toBe('summary-me');
      expect(route.summary).toEqual(summary);
    }
    ui.unmount();
  });

  it('Enter on a failed session without a summary stays on home and surfaces feedback', async () => {
    saveSummary(
      { projectDir, sessionId: 'failed-one' },
      makeSession({
        id: 'failed-one',
        feature: 'broken feature',
        status: 'failed',
        summary: null,
        startedAt: 1_700_000_600,
      }),
    );

    const ui = renderFeature(<HomeScreen commands={COMMANDS} onRuntimeCommand={() => {}} />);
    await flushEffects();

    ui.stdin.write(CTRL_R);
    await vi.waitFor(() => {
      expect(ui.lastFrame() ?? '').toContain(FOCUS_BAR);
    }, SESSION_FILTER_WAIT_MS);
    await flushEffects();
    ui.stdin.write(ENTER);
    await vi.waitFor(() => {
      expect(ui.lastFrame() ?? '').toContain('failed without a summary');
    }, SESSION_FILTER_WAIT_MS);

    expect(routerStore.get().screen).toBe('home');
    expect(ui.lastFrame() ?? '').toContain(FOCUS_BAR);
    ui.unmount();
  });

  it('plain Up still recalls input history instead of focusing the list', async () => {
    seedSessions(3);
    inputHistoryStore.push('recalled prompt');

    const ui = renderFeature(<HomeScreen commands={COMMANDS} onRuntimeCommand={() => {}} />);
    await flushEffects();

    ui.stdin.write(ARROW_UP);
    await flushEffects();

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('recalled prompt');
    expect(frame).not.toContain(FOCUS_BAR);
    ui.unmount();
  });

  it('drops focus and keeps the composer usable when the terminal shrinks below the list', async () => {
    seedSessions(3);
    const ui = renderFeature(<HomeScreen commands={COMMANDS} onRuntimeCommand={() => {}} />);
    await flushEffects();

    ui.stdin.write(CTRL_R);
    await flushEffects();
    expect(ui.lastFrame() ?? '').toContain(FOCUS_BAR);

    terminalSizeStore.__testReset({ cols: 80, rows: 12, isSmall: true });
    await flushEffects();
    expect(ui.lastFrame() ?? '').not.toContain(FOCUS_BAR);

    ui.stdin.write('hi');
    await flushEffects();
    expect(ui.lastFrame() ?? '').toContain('hi');
    ui.unmount();
  });
});
