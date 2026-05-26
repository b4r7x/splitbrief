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
  { kind: 'noarg', name: '/help', label: 'Help', description: 'Show help', validScreens: ['home'], handler: () => {} },
  { kind: 'arg', name: '/mode', label: 'Mode', description: 'Workflow mode', validScreens: ['home'], handler: () => {} },
];

function lineIndexContaining(frame: string, text: string): number {
  const index = frame.split('\n').findIndex(line => line.includes(text));
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
    const plannerLine = frame.split('\n').find(line => line.includes('Planner')) ?? '';
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
    expect(frame.split('\n')[footerLine + 1]).toContain('╰');
    expect(frame.split('\n')[inputPromptLine - 1]).toContain('╭');
    expect(inputPromptLine - 1).toBe(footerLine + 2);
    ui.unmount();
  });

  it('caps recent sessions and reports the hidden count in the home screen', async () => {
    terminalSizeStore.__testReset({ cols: 100, rows: 18, isSmall: true });

    for (let i = 0; i < 4; i++) {
      saveSummary(projectDir, `session-${i}`, makeSession({
        id: `session-${i}`,
        feature: `feature ${i}`,
        startedAt: 1_700_000_000 + i,
      }));
    }

    const ui = renderFeature(<HomeScreen commands={COMMANDS} onRuntimeCommand={() => {}} />);
    await tick(20);

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('feature 3');
    expect(frame).toContain('feature 2');
    expect(frame).not.toContain('feature 1');
    expect(frame).toContain('+2 more');
    ui.unmount();
  });

  it('does not load recent sessions when the compact layout hides them', async () => {
    terminalSizeStore.__testReset({ cols: 80, rows: 17, isSmall: true });
    saveSummary(projectDir, 'hidden-session', makeSession({
      id: 'hidden-session',
      feature: 'hidden feature',
    }));

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
});
