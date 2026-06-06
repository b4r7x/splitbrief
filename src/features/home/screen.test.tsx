import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderFeature, tick } from '#testing/helpers/ink.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeSession } from '#testing/helpers/factories/session.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { saveSummary } from '../../core/sessions/io.js';
import { saveState } from '../../core/state/persistence.js';
import { createInitialState } from '../../core/state/machine.js';
import { configStore } from '../../stores/project/config.js';
import { sessionsStore } from '../../stores/project/sessions.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { routerStore } from '../../stores/navigation/router.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { inputHistoryStore } from '../../stores/ui/input-history.js';
import { CURSOR } from '../../components/pickers/cursor-glyph.js';
import type { RuntimeCommandDef } from '../../core/runtime/commands/types.js';
import { getLogo } from './logo.js';
import { HomeScreen } from './screen.js';

const CTRL_R = '\x12';
const ARROW_DOWN = '\u001b[B';
const ARROW_UP = '\u001b[A';
const ESC = '\u001b';
const ENTER = '\r';
const DEFAULT_HOME_HINT = '/help /config /skills Ctrl+K';
const HOME_HINT = `Ctrl+R recent ${DEFAULT_HOME_HINT}`;
const RECENT_SESSIONS_HINT = '↑↓ navigate  Enter resume  Esc back';
// Ink collapses the trailing space of the cursor cell when it abuts the next
// column, so the rendered frame contains the bare ▸ glyph, not "▸ ".
const CURSOR_GLYPH = CURSOR.trimEnd();

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

function lineIndexContaining(frame: string, text: string): number {
  const index = frame.split('\n').findIndex((line) => line.includes(text));
  expect(index).toBeGreaterThanOrEqual(0);
  return index;
}

describe('HomeScreen', () => {
  let projectDir = '';

  beforeEach(() => {
    resetAllStores();
    projectDir = createTempDir('home-screen-test');
    configStore.__testReset({ config: makeConfig(), projectDir });
  });

  afterEach(() => {
    resetAllStores();
    cleanupTempDir(projectDir);
    projectDir = '';
  });

  it('centers the main content on wide terminals while keeping the input visible', async () => {
    terminalSizeStore.__testReset({ cols: 160, rows: 42, isSmall: false });

    const ui = renderFeature(<HomeScreen commands={COMMANDS} onRuntimeCommand={() => {}} />);
    await tick(20);

    const frame = ui.lastFrame() ?? '';
    const plannerLine = frame.split('\n').find((line) => line.includes('Planner')) ?? '';
    expect(plannerLine.indexOf('Planner')).toBeGreaterThan(0);
    expect(frame).toContain(DEFAULT_HOME_HINT);
    ui.unmount();
  });

  it('keeps useful compact content on short terminals', async () => {
    terminalSizeStore.__testReset({ cols: 80, rows: 20, isSmall: true });

    const ui = renderFeature(<HomeScreen commands={COMMANDS} onRuntimeCommand={() => {}} />);
    await tick(20);

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('__|_||_|');
    expect(frame).toContain('standard');
    expect(frame).toContain('no recent sessions');
    ui.unmount();
  });

  it('renders slash suggestions directly above the docked input', async () => {
    terminalSizeStore.__testReset({ cols: 120, rows: 34, isSmall: false });

    const ui = renderFeature(<HomeScreen commands={COMMANDS} onRuntimeCommand={() => {}} />);
    await tick(20);
    ui.stdin.write('/');
    await tick(20);

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('/help');
    expect(frame).toContain('Tab fill');
    const footerLine = lineIndexContaining(frame, 'Tab fill');
    const inputPromptLine = lineIndexContaining(frame, '> /');
    expect(inputPromptLine).toBeGreaterThan(footerLine);
    ui.unmount();
  });

  it('caps recent sessions and reports a hidden count when capacity is tight', async () => {
    terminalSizeStore.__testReset({ cols: 80, rows: 16, isSmall: true });

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
    await tick(20);

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('feature 24');
    expect(frame).toMatch(/\+\d+ more/);
    ui.unmount();
  });

  it('shows recent sessions on short terminals', async () => {
    terminalSizeStore.__testReset({ cols: 80, rows: 16, isSmall: true });
    saveSummary(
      { projectDir: projectDir, sessionId: 'short-session' },
      makeSession({
        id: 'short-session',
        feature: 'short feature',
      }),
    );

    const ui = renderFeature(<HomeScreen commands={COMMANDS} onRuntimeCommand={() => {}} />);
    await tick(20);

    expect(ui.lastFrame() ?? '').toContain('short feature');
    expect(sessionsStore.get().sessions.length).toBeGreaterThan(0);
    ui.unmount();
  });

  it('opens slash suggestions as an overlay without moving the centered content', async () => {
    terminalSizeStore.__testReset({ cols: 160, rows: 42, isSmall: false });

    const ui = renderFeature(<HomeScreen commands={COMMANDS} onRuntimeCommand={() => {}} />);
    await tick(20);

    const before = ui.lastFrame() ?? '';
    const plannerLine = lineIndexContaining(before, 'Planner');
    const modeLine = lineIndexContaining(before, 'Mode');

    ui.stdin.write('/');
    await tick(20);

    const after = ui.lastFrame() ?? '';
    expect(after).toContain('Tab fill');
    expect(lineIndexContaining(after, 'Planner')).toBe(plannerLine);
    expect(lineIndexContaining(after, 'Mode')).toBe(modeLine);
    ui.unmount();
  });

  it('renders full ASCII logo on large terminals', async () => {
    terminalSizeStore.__testReset({ cols: 120, rows: 30, isSmall: false });

    const ui = renderFeature(<HomeScreen commands={COMMANDS} onRuntimeCommand={() => {}} />);
    await tick(20);

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('__| (_)');
    const renderedLogoLines = getLogo('full')
      .split('\n')
      .filter((line) => frame.includes(line.trim()));
    expect(renderedLogoLines.length).toBeGreaterThanOrEqual(5);
    ui.unmount();
  });

  it('renders ASCII art on medium terminals', async () => {
    terminalSizeStore.__testReset({ cols: 80, rows: 20, isSmall: true });

    const ui = renderFeature(<HomeScreen commands={COMMANDS} onRuntimeCommand={() => {}} />);
    await tick(20);

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('__|_||_|');
    expect(frame.includes('── diptych ──')).toBe(false);
    ui.unmount();
  });

  it('renders ASCII art on small terminals', async () => {
    terminalSizeStore.__testReset({ cols: 80, rows: 15, isSmall: true });

    const ui = renderFeature(<HomeScreen commands={COMMANDS} onRuntimeCommand={() => {}} />);
    await tick(20);

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('__|_||_|');
    expect(frame.includes('── diptych ──')).toBe(false);
    ui.unmount();
  });

  it('shows many sessions on tall terminals', async () => {
    terminalSizeStore.__testReset({ cols: 120, rows: 60, isSmall: false });

    for (let i = 0; i < 20; i++) {
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
    await tick(20);

    const frame = ui.lastFrame() ?? '';
    const visibleCount = Array.from({ length: 20 }, (_, i) => `tall feature ${i}`).filter((label) =>
      frame.includes(label),
    ).length;
    expect(visibleCount).toBeGreaterThan(12);
    ui.unmount();
  });

  it('sessions appear close to the logo without excessive gap', async () => {
    terminalSizeStore.__testReset({ cols: 120, rows: 30, isSmall: false });

    saveSummary(
      { projectDir: projectDir, sessionId: 'gap-session' },
      makeSession({
        id: 'gap-session',
        feature: 'gap test feature',
        startedAt: 1_700_000_000,
      }),
    );

    const ui = renderFeature(<HomeScreen commands={COMMANDS} onRuntimeCommand={() => {}} />);
    await tick(20);

    const frame = ui.lastFrame() ?? '';
    const logoLine = frame.split('\n').findIndex((line) => line.includes('__| (_)'));
    const sessionLine = frame.split('\n').findIndex((line) => line.includes('gap test feature'));
    expect(logoLine).toBeGreaterThanOrEqual(0);
    expect(sessionLine).toBeGreaterThanOrEqual(0);
    expect(sessionLine - logoLine).toBeLessThan(15);
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
    resetAllStores();
    projectDir = createTempDir('home-focus-test');
    configStore.__testReset({ config: makeConfig(), projectDir });
    terminalSizeStore.__testReset({ cols: 120, rows: 60, isSmall: false });
  });

  afterEach(() => {
    resetAllStores();
    cleanupTempDir(projectDir);
    projectDir = '';
  });

  it('Ctrl+R focuses the recent-sessions list', async () => {
    seedSessions(3);
    const ui = renderFeature(<HomeScreen commands={COMMANDS} onRuntimeCommand={() => {}} />);
    await tick(20);

    expect(ui.lastFrame() ?? '').not.toContain(CURSOR_GLYPH);

    ui.stdin.write(CTRL_R);
    await tick(20);

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain(CURSOR_GLYPH);
    expect(frame).toContain(RECENT_SESSIONS_HINT);
    ui.unmount();
  });

  it('Ctrl+R is a no-op when there are no sessions', async () => {
    const ui = renderFeature(<HomeScreen commands={COMMANDS} onRuntimeCommand={() => {}} />);
    await tick(20);

    ui.stdin.write(CTRL_R);
    await tick(20);

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain(DEFAULT_HOME_HINT);
    expect(frame).not.toContain(CURSOR_GLYPH);
    ui.unmount();
  });

  it('Down moves the cursor to a later row', async () => {
    seedSessions(3);
    const ui = renderFeature(<HomeScreen commands={COMMANDS} onRuntimeCommand={() => {}} />);
    await tick(20);

    ui.stdin.write(CTRL_R);
    await tick(20);
    const before = lineIndexContaining(ui.lastFrame() ?? '', CURSOR_GLYPH);

    ui.stdin.write(ARROW_DOWN);
    await tick(20);
    const after = lineIndexContaining(ui.lastFrame() ?? '', CURSOR_GLYPH);

    expect(after).toBeGreaterThan(before);
    ui.unmount();
  });

  it('Esc returns focus to the composer', async () => {
    seedSessions(3);
    const ui = renderFeature(<HomeScreen commands={COMMANDS} onRuntimeCommand={() => {}} />);
    await tick(20);

    ui.stdin.write(CTRL_R);
    await tick(20);
    expect(ui.lastFrame() ?? '').toContain(CURSOR_GLYPH);

    ui.stdin.write(ESC);
    await tick(20);

    const frame = ui.lastFrame() ?? '';
    expect(frame).not.toContain(CURSOR_GLYPH);
    expect(frame).toContain(HOME_HINT);
    ui.unmount();
  });

  it('Up at the top returns focus to the composer without wrapping', async () => {
    seedSessions(3);
    const ui = renderFeature(<HomeScreen commands={COMMANDS} onRuntimeCommand={() => {}} />);
    await tick(20);

    ui.stdin.write(CTRL_R);
    await tick(20);
    expect(ui.lastFrame() ?? '').toContain(CURSOR_GLYPH);

    ui.stdin.write(ARROW_UP);
    await tick(20);

    const frame = ui.lastFrame() ?? '';
    expect(frame).not.toContain(CURSOR_GLYPH);
    expect(frame).toContain(HOME_HINT);
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
    await tick(20);

    ui.stdin.write(CTRL_R);
    await tick(20);
    ui.stdin.write(ENTER);
    await tick(20);

    const route = routerStore.get();
    expect(route.screen).toBe('workflow');
    if (route.screen === 'workflow') {
      expect(route.sessionId).toBe('resume-me');
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
    await tick(20);

    ui.stdin.write(CTRL_R);
    await tick(20);
    ui.stdin.write(ENTER);
    await tick(20);

    expect(routerStore.get().screen).toBe('home');
    expect(feedbackStore.get().message ?? '').toContain('broken feature');
    expect(ui.lastFrame() ?? '').toContain(CURSOR_GLYPH);
    ui.unmount();
  });

  it('plain Up still recalls input history instead of focusing the list', async () => {
    seedSessions(3);
    inputHistoryStore.push('recalled prompt');

    const ui = renderFeature(<HomeScreen commands={COMMANDS} onRuntimeCommand={() => {}} />);
    await tick(20);

    ui.stdin.write(ARROW_UP);
    await tick(20);

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('recalled prompt');
    expect(frame).not.toContain(CURSOR_GLYPH);
    ui.unmount();
  });

  it('drops focus and keeps the composer usable when the terminal shrinks below the list', async () => {
    seedSessions(3);
    const ui = renderFeature(<HomeScreen commands={COMMANDS} onRuntimeCommand={() => {}} />);
    await tick(20);

    ui.stdin.write(CTRL_R);
    await tick(20);
    expect(ui.lastFrame() ?? '').toContain(CURSOR_GLYPH);

    terminalSizeStore.__testReset({ cols: 80, rows: 12, isSmall: true });
    await tick(20);
    expect(ui.lastFrame() ?? '').not.toContain(CURSOR_GLYPH);

    ui.stdin.write('hi');
    await tick(20);
    expect(ui.lastFrame() ?? '').toContain('hi');
    ui.unmount();
  });
});
