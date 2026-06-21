import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderFeature, tick } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import type { RuntimeCommandDef } from '../../core/runtime/commands/types.js';
import type { Screen } from '../../core/navigation/types.js';
import { HelpOverlay } from './overlay.js';

const PAGE_DOWN = '\u001b[6~';
const HOME = '\u001b[H';
const END = '\u001b[F';

function command(name: string, validScreens: Screen[]): RuntimeCommandDef {
  return {
    kind: 'noarg',
    name,
    description: `${name.slice(1)} command`,
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

  it('shows workflow scroll and activity affordances', async () => {
    terminalSizeStore.__testReset({ cols: 120, rows: 40, isSmall: false });
    const ui = renderFeature(
      <HelpOverlay
        currentScreen="workflow"
        commands={[
          command('/scroll', ['workflow']),
          command('/activity', ['workflow']),
          command('/skills', ['home']),
        ]}
      />,
    );
    await tick(20);

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('/scroll');
    expect(frame).toContain('/activity');
    expect(frame).toContain('Shift+↑/↓, PgUp/PgDn, Home/End, Ctrl+B/F');
    expect(frame).toContain('PageUp/PageDown');
    expect(frame).toContain('/scroll top|bottom');
    expect(frame).toContain('Alt+A, /activity');
    expect(frame).toContain('Expand activity rows');
    expect(frame).not.toContain('Ctrl+A');

    ui.unmount();
  });

  it('pages through help content on short terminals', async () => {
    terminalSizeStore.__testReset({ cols: 80, rows: 12, isSmall: true });
    const commands = Array.from({ length: 8 }, (_, i) => command(`/cmd-${i}`, ['home']));
    const ui = renderFeature(<HelpOverlay currentScreen="home" commands={commands} />);
    await tick(20);

    ui.stdin.write(HOME);
    await tick(20);

    for (let i = 0; i < 3; i++) {
      if ((ui.lastFrame() ?? '').includes('/cmd-0')) break;
      ui.stdin.write(PAGE_DOWN);
      await tick(20);
    }
    expect(ui.lastFrame() ?? '').toContain('/cmd-0');

    for (let i = 0; i < 10; i++) {
      if ((ui.lastFrame() ?? '').includes('/cmd-7')) break;
      ui.stdin.write(PAGE_DOWN);
      await tick(20);
    }

    expect(ui.lastFrame() ?? '').toContain('/cmd-7');

    ui.unmount();
  });

  it('keeps top and bottom borders visible while paging on a short terminal', async () => {
    terminalSizeStore.__testReset({ cols: 80, rows: 12, isSmall: true });
    const commands = Array.from({ length: 8 }, (_, i) => command(`/cmd-${i}`, ['home']));
    const ui = renderFeature(<HelpOverlay currentScreen="home" commands={commands} />);
    await tick(20);

    const borderChar = '─';
    const initial = ui.lastFrame() ?? '';
    expect(initial).toContain(borderChar);

    ui.stdin.write(END);
    await tick(20);

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain(borderChar);
    expect(frame).toContain('╰');
    expect(frame).toContain('close');

    ui.unmount();
  });
});
