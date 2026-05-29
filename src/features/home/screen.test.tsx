import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderFeature, tick } from '../../../testing/helpers/ink.js';
import { makeConfig } from '../../../testing/helpers/factories/config.js';
import { makeSession } from '../../../testing/helpers/factories/session.js';
import { createTempDir, cleanupTempDir } from '../../../testing/helpers/temp-dir.js';
import { resetAllStores } from '../../../testing/helpers/stores.js';
import { saveSummary } from '../../core/sessions/io.js';
import { configStore } from '../../stores/project/config.js';
import { sessionsStore } from '../../stores/project/sessions.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import type { RuntimeCommandDef } from '../../core/runtime/commands/types.js';
import { HomeScreen } from './screen.js';

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
    expect(frame).toContain('/help /config /skills Ctrl+K');
    ui.unmount();
  });

  it('keeps useful compact content on short terminals', async () => {
    terminalSizeStore.__testReset({ cols: 80, rows: 20, isSmall: true });

    const ui = renderFeature(<HomeScreen commands={COMMANDS} onRuntimeCommand={() => {}} />);
    await tick(20);

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('diptych');
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
    // The slash-suggestion footer sits directly above the docked input prompt,
    // separated only by the panel border lines.
    expect(inputPromptLine).toBeGreaterThan(footerLine);
    expect(inputPromptLine - 1).toBe(footerLine + 2);
    ui.unmount();
  });

  it('caps recent sessions and reports the hidden count in the home screen', async () => {
    terminalSizeStore.__testReset({ cols: 100, rows: 18, isSmall: true });

    for (let i = 0; i < 10; i++) {
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
    expect(frame).toContain('feature 9');
    expect(frame).toContain('feature 8');
    expect(frame).toContain('+2 more');
    ui.unmount();
  });

  it('does not load recent sessions when the compact layout hides them', async () => {
    terminalSizeStore.__testReset({ cols: 80, rows: 17, isSmall: true });
    saveSummary(
      { projectDir: projectDir, sessionId: 'hidden-session' },
      makeSession({
        id: 'hidden-session',
        feature: 'hidden feature',
      }),
    );

    const ui = renderFeature(<HomeScreen commands={COMMANDS} onRuntimeCommand={() => {}} />);
    await tick(20);

    expect(ui.lastFrame() ?? '').not.toContain('hidden feature');
    expect(sessionsStore.get().sessions).toEqual([]);
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
    ui.unmount();
  });

  it('renders small logo on medium terminals', async () => {
    terminalSizeStore.__testReset({ cols: 80, rows: 20, isSmall: true });

    const ui = renderFeature(<HomeScreen commands={COMMANDS} onRuntimeCommand={() => {}} />);
    await tick(20);

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('── diptych ──');
    ui.unmount();
  });

  it('renders plain text logo on small terminals', async () => {
    terminalSizeStore.__testReset({ cols: 80, rows: 15, isSmall: true });

    const ui = renderFeature(<HomeScreen commands={COMMANDS} onRuntimeCommand={() => {}} />);
    await tick(20);

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('diptych');
    ui.unmount();
  });

  it('shows many sessions on tall terminals', async () => {
    terminalSizeStore.__testReset({ cols: 120, rows: 60, isSmall: false });

    for (let i = 0; i < 10; i++) {
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
    for (let i = 0; i < 10; i++) {
      expect(frame).toContain(`tall feature ${i}`);
    }
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
