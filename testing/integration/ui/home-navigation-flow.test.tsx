import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderFeature, tick } from '../../../testing/helpers/ink.js';
import { makeConfig } from '../../../testing/helpers/factories/config.js';
import { makeSession } from '../../../testing/helpers/factories/session.js';
import { createTempDir, cleanupTempDir } from '../../../testing/helpers/temp-dir.js';
import { resetAllStores } from '../../../testing/helpers/stores.js';
import { saveSummary } from '../../../src/core/sessions/io.js';
import { saveState } from '../../../src/core/state/persistence.js';
import { createInitialState } from '../../../src/core/state/machine.js';
import { configStore } from '../../../src/stores/project/config.js';
import { terminalSizeStore } from '../../../src/stores/ui/terminal-size.js';
import { routerStore } from '../../../src/stores/navigation/router.js';
import { feedbackStore } from '../../../src/stores/ui/feedback.js';
import { inputHistoryStore } from '../../../src/stores/ui/input-history.js';
import { CURSOR } from '../../../src/components/pickers/cursor-glyph.js';
import { App } from '../../../src/app.js';

const CTRL_R = '\x12';
const ARROW_DOWN = '\u001b[B';
const ARROW_UP = '\u001b[A';
const ESC = '\u001b';
const ENTER = '\r';
const HOME_HINT = 'Ctrl+R recent /help /config /skills Ctrl+K';
const RECENT_SESSIONS_HINT = '↑↓ navigate  Enter resume  Esc back';
// Ink collapses the trailing space of the cursor cell when it abuts the next
// column, so the rendered frame contains the bare glyph, not the padded cell.
const CURSOR_GLYPH = CURSOR.trimEnd();

function lineIndexContaining(frame: string, text: string): number {
  const index = frame.split('\n').findIndex((line) => line.includes(text));
  expect(index).toBeGreaterThanOrEqual(0);
  return index;
}

describe('home navigation flow (through real App)', () => {
  let projectDir = '';

  beforeEach(() => {
    resetAllStores();
    projectDir = createTempDir('home-nav-flow');
    configStore.__testReset({ config: makeConfig(), projectDir });
    terminalSizeStore.__testReset({ cols: 120, rows: 60, isSmall: false });
  });

  afterEach(() => {
    resetAllStores();
    cleanupTempDir(projectDir);
    projectDir = '';
  });

  it('boots home (logo + recent sessions), then Ctrl+R + Enter swaps the whole stack to the workflow screen', async () => {
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
    saveState(
      { projectDir, sessionId: 'resume-me' },
      { ...createInitialState('resume feature'), phase: 'implementing' as const },
    );

    const ui = renderFeature(<App />);
    await tick(20);

    const boot = ui.lastFrame() ?? '';
    expect(boot).toContain('__| (_)');
    expect(boot).toContain('Recent sessions');

    ui.stdin.write(CTRL_R);
    await tick(20);

    const focused = ui.lastFrame() ?? '';
    expect(focused).toContain(CURSOR_GLYPH);
    expect(focused).toContain(RECENT_SESSIONS_HINT);

    ui.stdin.write(ENTER);
    await tick(20);

    const route = routerStore.get();
    expect(route.screen).toBe('workflow');
    if (route.screen === 'workflow') {
      expect(route.sessionId).toBe('resume-me');
    }
    expect(ui.lastFrame() ?? '').toContain('Checking run readiness...');

    ui.unmount();
  });

  it('Down then Esc returns focus to a usable composer that accepts typed input', async () => {
    for (let i = 0; i < 3; i++) {
      saveSummary(
        { projectDir, sessionId: `focus-${i}` },
        makeSession({
          id: `focus-${i}`,
          feature: `focus feature ${i}`,
          status: 'interrupted',
          summary: null,
          startedAt: 1_700_000_000 + i,
        }),
      );
    }

    const ui = renderFeature(<App />);
    await tick(20);

    ui.stdin.write(CTRL_R);
    await tick(20);
    const focused = ui.lastFrame() ?? '';
    expect(focused).toContain(CURSOR_GLYPH);
    expect(focused).toContain(RECENT_SESSIONS_HINT);
    const before = lineIndexContaining(focused, CURSOR_GLYPH);

    ui.stdin.write(ARROW_DOWN);
    await vi.waitFor(() => {
      const after = lineIndexContaining(ui.lastFrame() ?? '', CURSOR_GLYPH);
      expect(after).toBeGreaterThan(before);
    });

    ui.stdin.write(ESC);
    await tick(20);
    const dropped = ui.lastFrame() ?? '';
    expect(dropped).not.toContain(CURSOR_GLYPH);
    expect(dropped).toContain(HOME_HINT);
    expect(routerStore.get().screen).toBe('home');

    ui.stdin.write('hello');
    await tick(20);
    expect(ui.lastFrame() ?? '').toContain('hello');

    ui.unmount();
  });

  it('plain Up recalls input history instead of focusing the list', async () => {
    for (let i = 0; i < 3; i++) {
      saveSummary(
        { projectDir, sessionId: `focus-${i}` },
        makeSession({
          id: `focus-${i}`,
          feature: `focus feature ${i}`,
          status: 'interrupted',
          summary: null,
          startedAt: 1_700_000_000 + i,
        }),
      );
    }
    inputHistoryStore.push('recalled prompt');

    const ui = renderFeature(<App />);
    await tick(20);

    ui.stdin.write(ARROW_UP);
    await tick(20);

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('recalled prompt');
    expect(frame).not.toContain(CURSOR_GLYPH);

    ui.unmount();
  });

  it('resuming an interrupted session with missing persisted state stays on home and surfaces an error', async () => {
    saveSummary(
      { projectDir, sessionId: 'no-state' },
      makeSession({
        id: 'no-state',
        feature: 'orphan feature',
        status: 'interrupted',
        summary: null,
        startedAt: 1_700_000_700,
      }),
    );

    const ui = renderFeature(<App />);
    await tick(20);

    ui.stdin.write(CTRL_R);
    await tick(20);
    ui.stdin.write(ENTER);
    await tick(20);

    expect(routerStore.get().screen).toBe('home');
    expect(ui.lastFrame() ?? '').not.toContain(HOME_HINT);
    expect(ui.lastFrame() ?? '').toContain(CURSOR_GLYPH);

    const fb = feedbackStore.get();
    expect(fb.message ?? '').toContain('orphan feature');
    expect(fb.message ?? '').toContain('missing or invalid');

    ui.unmount();
  });
});
