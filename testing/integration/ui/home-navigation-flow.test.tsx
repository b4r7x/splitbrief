import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { forceUnicodeGlyphs } from '#testing/helpers/glyphs.js';
import { renderFeature, flushEffects, tick } from '#testing/helpers/ink.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeSession } from '#testing/helpers/factories/session.js';
import { makeSummary } from '#testing/helpers/factories/summary.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { trustDeclaredRunners } from '#testing/helpers/runner-trust.js';
import { writeConfig } from '../../../src/core/config/load/io.js';
import { saveSummary } from '../../../src/core/sessions/io.js';
import { saveState } from '../../../src/core/state/persistence.js';
import { createInitialState } from '../../../src/core/state/machine.js';
import { configStore } from '../../../src/stores/project/config.js';
import { sessionsStore } from '../../../src/stores/project/sessions.js';
import { terminalSizeStore } from '../../../src/stores/ui/terminal-size.js';
import { routerStore } from '../../../src/stores/navigation/router.js';
import { inputHistoryStore } from '../../../src/stores/ui/input-history.js';
import { sessionSelectStore } from '../../../src/stores/navigation/session-select.js';
import { App } from '../../../src/app/root.js';

const CTRL_R = '\x12';
const ARROW_DOWN = '\u001b[B';
const ARROW_UP = '\u001b[A';
const ESC = '\u001b';
const ENTER = '\r';
const FOCUS_BAR = '▌';
const SESSION_FILTER_WAIT_MS = 5000;
const workflowDeps = { runWorkflow: () => new Promise<never>(() => {}) };

// Ink lays out at stdout.columns, so a mount that ignores the seeded viewport
// renders the body at a width the screen never asked for: at 120 the wide body
// overflows the helper's 100-column default and the frame loses its left edge.
function seededViewport() {
  const { cols, rows } = terminalSizeStore.get();
  return { cols, rows };
}

async function focusRecentSessions(ui: ReturnType<typeof renderFeature>): Promise<void> {
  await flushEffects();
  ui.stdin.write(CTRL_R);
  await vi.waitFor(() => {
    expect(ui.lastFrame() ?? '').toContain('esc back');
  });
  await flushEffects();
}

function seedInterruptedSession(
  projectDir: string,
  sessionId: string,
  feature: string,
  startedAt: number,
): void {
  saveSummary(
    { projectDir, sessionId },
    makeSession({
      id: sessionId,
      feature,
      status: 'open',
      summary: null,
      startedAt,
    }),
  );
  saveState(
    { projectDir, sessionId },
    { ...createInitialState(feature), phase: 'implementing' as const },
  );
  sessionsStore.load(projectDir);
}

describe('home navigation flow (through real App)', () => {
  let projectDir = '';
  let trustHome = '';

  beforeEach(async () => {
    forceUnicodeGlyphs();
    resetAllStores();
    projectDir = createTempDir('home-nav-flow');
    trustHome = createTempDir('home-nav-flow-home');
    createTestGitRepo(projectDir);
    const config = makeConfig({
      planner: { kind: 'agent', command: process.execPath, args: ['-e', ''] },
      implementer: {
        kind: 'agent',
        command: process.execPath,
        args: ['-e', ''],
        model: 'test-model',
      },
    });
    writeConfig(projectDir, config);
    // Resuming admits the declared command runners, so this fixture models an
    // owner who already granted them — into a throwaway home, never the
    // developer's own trust store.
    vi.stubEnv('HOME', trustHome);
    await trustDeclaredRunners({ projectDir, config });
    configStore.__testReset({
      config,
      projectDir,
    });
    terminalSizeStore.__testReset({ cols: 120, rows: 60, isSmall: false });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetAllStores();
    cleanupTempDir(projectDir);
    cleanupTempDir(trustHome);
    projectDir = '';
    trustHome = '';
  });

  it('Ctrl+R then Enter opens the focused session on the workflow screen', async () => {
    seedInterruptedSession(projectDir, 'resume-me', 'resume feature', 1_700_000_500);

    sessionsStore.load(projectDir);
    const ui = renderFeature(<App workflowDeps={workflowDeps} />, seededViewport());
    await tick(20);

    await focusRecentSessions(ui);
    await flushEffects();
    ui.stdin.write(ENTER);
    await vi.waitFor(() => {
      expect({ route: routerStore.get(), error: sessionSelectStore.get().error }).toMatchObject({
        route: { screen: 'workflow' },
        error: null,
      });
    }, SESSION_FILTER_WAIT_MS);

    const route = routerStore.get();
    if (route.screen !== 'workflow' || route.execution.kind !== 'at-rest') {
      throw new Error('expected a workflow route at rest');
    }
    expect(route.run.ref.sessionId).toBe('resume-me');

    ui.unmount();
  });

  it('opens a finished run at rest and Esc returns home', async () => {
    const summary = makeSummary({ feature: 'completed feature' });
    saveSummary(
      { projectDir, sessionId: 'summary-me' },
      makeSession({
        id: 'summary-me',
        feature: 'completed feature',
        status: 'complete',
        summary,
        startedAt: 1_700_000_600,
      }),
    );

    sessionsStore.load(projectDir);
    const ui = renderFeature(<App workflowDeps={workflowDeps} />, seededViewport());
    await tick(20);

    await focusRecentSessions(ui);
    await flushEffects();
    ui.stdin.write(ENTER);
    await vi.waitFor(() => {
      expect(routerStore.get().screen).toBe('workflow');
    });

    const route = routerStore.get();
    if (route.screen === 'workflow') {
      expect(route.run.ref.sessionId).toBe('summary-me');
      expect(route.run.summary).toEqual(summary);
      expect(route.execution.kind).toBe('at-rest');
    }

    await flushEffects();
    ui.stdin.write(ESC);
    await vi.waitFor(() => {
      expect(routerStore.get().screen).toBe('home');
    });

    ui.unmount();
  });

  it('Down then Enter opens the next recent session', async () => {
    for (let i = 0; i < 3; i++) {
      seedInterruptedSession(projectDir, `focus-${i}`, `focus feature ${i}`, 1_700_000_000 + i);
    }

    sessionsStore.load(projectDir);
    const ui = renderFeature(<App workflowDeps={workflowDeps} />, seededViewport());
    await tick(20);

    await focusRecentSessions(ui);
    await flushEffects();
    ui.stdin.write(ARROW_DOWN);
    await vi.waitFor(() => {
      expect(ui.lastFrame() ?? '').toMatch(/focus feature 1/);
    });
    await flushEffects();
    ui.stdin.write(ENTER);

    await vi.waitFor(() => {
      expect(routerStore.get().screen).toBe('workflow');
    }, SESSION_FILTER_WAIT_MS);
    const route = routerStore.get();
    if (route.screen !== 'workflow' || route.execution.kind !== 'at-rest') {
      throw new Error('expected a workflow route at rest');
    }
    expect(route.run.ref.sessionId).toBe('focus-1');

    ui.unmount();
  });

  it('Esc after recent-session focus returns to a composer that accepts typed input', async () => {
    for (let i = 0; i < 3; i++) {
      seedInterruptedSession(projectDir, `focus-${i}`, `focus feature ${i}`, 1_700_000_000 + i);
    }

    sessionsStore.load(projectDir);
    const ui = renderFeature(<App workflowDeps={workflowDeps} />, seededViewport());
    await tick(20);

    await focusRecentSessions(ui);
    await flushEffects();
    ui.stdin.write(ESC);
    await vi.waitFor(() => {
      expect(routerStore.get().screen).toBe('home');
      const frame = ui.lastFrame() ?? '';
      expect(frame).not.toContain('esc back');
      expect(frame).not.toContain(FOCUS_BAR);
      expect(frame).toContain('ctrl+k commands');
    }, SESSION_FILTER_WAIT_MS);
    await flushEffects();
    ui.stdin.write('hello');
    await vi.waitFor(() => {
      expect(ui.lastFrame() ?? '').toContain('hello');
    }, SESSION_FILTER_WAIT_MS);

    ui.unmount();
  });

  it('plain Up recalls input history instead of focusing the list', async () => {
    for (let i = 0; i < 3; i++) {
      seedInterruptedSession(projectDir, `focus-${i}`, `focus feature ${i}`, 1_700_000_000 + i);
    }
    inputHistoryStore.push('recalled prompt');

    sessionsStore.load(projectDir);
    const ui = renderFeature(<App workflowDeps={workflowDeps} />, seededViewport());
    await flushEffects();

    ui.stdin.write(ARROW_UP);
    await tick(20);

    expect(ui.lastFrame() ?? '').toContain('recalled prompt');

    ui.unmount();
  });

  it('opens a run whose state cannot be read, then Down then Enter opens the next one', async () => {
    saveSummary(
      { projectDir, sessionId: 'no-state' },
      makeSession({
        id: 'no-state',
        feature: 'orphan feature',
        status: 'open',
        summary: null,
        startedAt: 1_700_000_700,
      }),
    );
    seedInterruptedSession(projectDir, 'recover-me', 'recover feature', 1_700_000_600);

    sessionsStore.load(projectDir);
    const ui = renderFeature(<App workflowDeps={workflowDeps} />, seededViewport());
    await tick(20);

    await focusRecentSessions(ui);
    await flushEffects();
    ui.stdin.write(ENTER);

    // A run that left nothing readable behind still opens: the screen says so in its byline
    // rather than refusing to show the run at all.
    await vi.waitFor(() => {
      expect({ screen: routerStore.get().screen, error: sessionSelectStore.get().error }).toEqual({
        screen: 'workflow',
        error: null,
      });
    }, SESSION_FILTER_WAIT_MS);
    const orphan = routerStore.get();
    if (orphan.screen !== 'workflow' || orphan.execution.kind !== 'at-rest') {
      throw new Error('expected a workflow route at rest');
    }
    expect(orphan.run.ref.sessionId).toBe('no-state');
    expect(orphan.run.hydration.kind).not.toBe('loaded');

    ui.stdin.write(ESC);
    await vi.waitFor(() => {
      expect(routerStore.get().screen).toBe('home');
    }, SESSION_FILTER_WAIT_MS);

    await focusRecentSessions(ui);
    await flushEffects();
    ui.stdin.write(ARROW_DOWN);
    await flushEffects();
    ui.stdin.write(ENTER);

    await vi.waitFor(() => {
      expect(routerStore.get().screen).toBe('workflow');
    }, SESSION_FILTER_WAIT_MS);
    const route = routerStore.get();
    if (route.screen !== 'workflow' || route.execution.kind !== 'at-rest') {
      throw new Error('expected a workflow route at rest');
    }
    expect(route.run.ref.sessionId).toBe('recover-me');

    ui.unmount();
  });
});
