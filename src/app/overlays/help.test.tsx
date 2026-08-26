import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { flushEffects, renderFeature, tick } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { controlsStore } from '../../stores/ui/controls.js';
import { lifecycleStore } from '../../stores/workflow/lifecycle.js';
import type { RuntimeCommandDef } from '../../core/runtime/commands/types.js';
import type { Screen } from '../../core/navigation/types.js';
import { HelpOverlay } from './help.js';

const PAGE_DOWN = '\u001b[6~';
const HOME = '\u001b[H';
const END = '\u001b[F';

function command(name: string, validScreens: Screen[]): RuntimeCommandDef {
  return {
    kind: 'noarg',
    name,
    description: `${name.slice(1)} command`,
    category: 'navigate',
    validScreens,
    handler: () => {},
  };
}

describe('HelpOverlay', () => {
  beforeEach(() => {
    resetAllStores();
    terminalSizeStore.__testReset({ cols: 80, rows: 24, isSmall: false });
  });

  afterEach(() => {
    resetAllStores();
  });

  it('shows only commands valid for the current screen', async () => {
    const ui = renderFeature(
      <HelpOverlay
        currentScreen="home"
        commands={[
          command('/skills', ['home']),
          command('/redo-task', ['workflow']),
          command('/home', ['workflow', 'summary']),
        ]}
      />,
    );
    await tick(20);

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('/skills');
    expect(frame).not.toContain('/redo-task');
    expect(frame).not.toContain('/home');

    ui.unmount();
  });

  it('hides a command whose guard blocks it and shows it once the guard passes', async () => {
    const redoTask: RuntimeCommandDef = {
      ...command('/redo-task', ['home']),
      guard: (ctx) => (ctx.phase === 'implementing' ? undefined : 'no task is running'),
    };

    const blocked = renderFeature(<HelpOverlay currentScreen="home" commands={[redoTask]} />);
    await tick(20);
    expect(blocked.lastFrame() ?? '').not.toContain('/redo-task');
    blocked.unmount();

    lifecycleStore.__testReset({ phase: 'implementing' });
    const allowed = renderFeature(<HelpOverlay currentScreen="home" commands={[redoTask]} />);
    await tick(20);
    expect(allowed.lastFrame() ?? '').toContain('/redo-task');
    allowed.unmount();
  });

  it('lists aliases as their own rows pointing at the command they run', async () => {
    const settings: RuntimeCommandDef = {
      ...command('/settings', ['home']),
      aliases: [{ name: '/config' }],
    };

    const ui = renderFeature(<HelpOverlay currentScreen="home" commands={[settings]} />);
    await tick(20);

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('/config');
    expect(frame).toContain('Alias for /settings');

    ui.unmount();
  });

  it('shows category headers when there is room and drops them at the floor', async () => {
    const crew: RuntimeCommandDef = { ...command('/crew', ['home']), category: 'crew' };
    const commands = [command('/skills', ['home']), crew];

    terminalSizeStore.__testReset({ cols: 120, rows: 40, isSmall: false });
    const roomy = renderFeature(<HelpOverlay currentScreen="home" commands={commands} />);
    await tick(20);
    const roomyFrame = roomy.lastFrame() ?? '';
    expect(roomyFrame).toContain('Navigate');
    expect(roomyFrame).toContain('Crew');
    expect(roomyFrame).toContain('Keyboard shortcuts');
    roomy.unmount();

    // 60x18: 18 rows - 0 gutter - 8 chrome = 10 list slots, below the 12-slot header threshold.
    terminalSizeStore.__testReset({ cols: 60, rows: 18, isSmall: true });
    const floorCommands = Array.from({ length: 12 }, (_, i) => command(`/cmd-${i}`, ['home']));
    const floor = renderFeature(<HelpOverlay currentScreen="home" commands={floorCommands} />);
    await tick(20);

    const floorFrame = floor.lastFrame() ?? '';
    expect(floorFrame).not.toContain('Navigate');
    expect(floorFrame).not.toContain('Keyboard shortcuts');
    // 10 slots minus the single "N more" indicator row leaves 9 command rows.
    expect((floorFrame.match(/\/cmd-/g) ?? []).length).toBeGreaterThanOrEqual(7);
    floor.unmount();
  });

  it('shows workflow scroll and activity affordances', async () => {
    terminalSizeStore.__testReset({ cols: 120, rows: 40, isSmall: false });
    const ui = renderFeature(
      <HelpOverlay
        currentScreen="workflow"
        commands={[
          command('/scroll', ['workflow']),
          command('/activity', ['workflow']),
          command('/sidebar', ['workflow']),
          command('/skills', ['home']),
        ]}
      />,
    );
    await tick(20);

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('/scroll');
    expect(frame).toContain('/activity');
    expect(frame).toContain('/sidebar');
    expect(frame).toContain('shift+↑/↓, pgup/pgdn, home/end');
    expect(frame).toContain('PageUp/PageDown');
    expect(frame).toContain('/scroll top|bottom');
    expect(frame).toContain('/activity, ctrl+a');
    expect(frame).toContain('Expand activity rows');
    expect(frame).not.toContain('Alt+A');
    expect(frame).not.toContain('Ctrl+B/F');
    expect(frame).not.toContain('Ctrl+E');

    ui.unmount();
  });

  it('panel bottom border sits directly under the hint for a short document', async () => {
    const ui = renderFeature(<HelpOverlay currentScreen="home" commands={[]} />);
    await tick(20);

    const lines = (ui.lastFrame() ?? '').split('\n');
    const hintIndex = lines.findIndex((line) => line.includes('↑↓ scroll · esc close'));
    expect(hintIndex).toBeGreaterThanOrEqual(0);
    expect(lines[hintIndex + 1]?.trim()).not.toBe('');
    expect(lines[hintIndex + 2]).toMatch(/[-─]/);

    ui.unmount();
  });

  it('renders zero indicator rows when the document fits / indicators when it overflows', async () => {
    const shortUi = renderFeature(<HelpOverlay currentScreen="home" commands={[]} />);
    await tick(20);
    expect(shortUi.lastFrame() ?? '').not.toContain('more');
    shortUi.unmount();

    terminalSizeStore.__testReset({ cols: 80, rows: 12, isSmall: true });
    const commands = Array.from({ length: 8 }, (_, i) => command(`/cmd-${i}`, ['home']));
    const overflowUi = renderFeature(<HelpOverlay currentScreen="home" commands={commands} />);
    await tick(20);

    expect(overflowUi.lastFrame() ?? '').toContain('more');
    overflowUi.unmount();
  });

  it('shows Ctrl+E only when workflow help opens in review mode', async () => {
    terminalSizeStore.__testReset({ cols: 120, rows: 40, isSmall: false });
    controlsStore.setInputMode('review');
    const ui = renderFeature(
      <HelpOverlay currentScreen="workflow" commands={[command('/scroll', ['workflow'])]} />,
    );
    await tick(20);

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('ctrl+e');
    expect(frame).toContain('Open editor in review mode only');

    ui.unmount();
  });

  it('pages through help content on short terminals', async () => {
    terminalSizeStore.__testReset({ cols: 80, rows: 12, isSmall: true });
    const commands = Array.from({ length: 12 }, (_, i) => command(`/cmd-${i}`, ['home']));
    const ui = renderFeature(<HelpOverlay currentScreen="home" commands={commands} />);
    await flushEffects();

    expect(ui.lastFrame() ?? '').toContain('/cmd-0');
    expect(ui.lastFrame() ?? '').not.toContain('/cmd-11');

    ui.stdin.write(PAGE_DOWN);
    await tick(20);
    expect(ui.lastFrame() ?? '').not.toContain('/cmd-0');

    await flushEffects();
    ui.stdin.write(END);
    await tick(20);
    const endFrame = ui.lastFrame() ?? '';
    expect(endFrame).not.toContain('/cmd-0');

    // End is the last row: paging further cannot move the viewport.
    await flushEffects();
    ui.stdin.write(PAGE_DOWN);
    await tick(20);
    expect(ui.lastFrame() ?? '').toBe(endFrame);

    await flushEffects();
    ui.stdin.write(HOME);
    await tick(20);
    expect(ui.lastFrame() ?? '').toContain('/cmd-0');

    ui.unmount();
  });

  it('keeps the overlay hint visible while paging on a short terminal', async () => {
    terminalSizeStore.__testReset({ cols: 80, rows: 12, isSmall: true });
    const commands = Array.from({ length: 8 }, (_, i) => command(`/cmd-${i}`, ['home']));
    const ui = renderFeature(<HelpOverlay currentScreen="home" commands={commands} />);
    await tick(20);

    const initial = ui.lastFrame() ?? '';
    expect(initial).toContain('close');

    await flushEffects();
    ui.stdin.write(END);
    await tick(20);

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('close');

    ui.unmount();
  });
});
