import { Text } from 'ink';
import { render } from 'ink-testing-library';
import { beforeEach, describe, expect, it } from 'vitest';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { getTheme } from '../theme.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import {
  OverlayPanel,
  computeOverlayInnerRowCapacity,
  computeOverlayInnerWidth,
  OVERLAY_PANEL_FRAME_ROWS,
} from './overlay-panel.js';

function colorOpen(color: string): string {
  const ui = render(<Text color={color}>x</Text>);
  const frame = ui.lastFrame() ?? '';
  ui.unmount();
  return frame.slice(0, frame.indexOf('x'));
}

describe('OverlayPanel title', () => {
  beforeEach(() => {
    terminalSizeStore.__testReset({ cols: 80, rows: 24, isSmall: false });
  });

  // §1.1 accent budget: surface titles are quiet dim metadata; the lone accent per region is the
  // focused row's `▌` bar. A `·`-separated title must never accent its head (the prior regression).
  it.each([
    'help · commands & shortcuts',
    'cost · breakdown',
    'sessions · 3',
    'setup · planner · 1 of 2',
  ])('renders "%s" dim with no accent head', (title) => {
    const theme = getTheme('terminal');
    const accentOpen = colorOpen(theme.accent);
    const dimOpen = colorOpen(theme.textDim);

    const ui = render(
      <OverlayPanel title={title}>
        <Text>body</Text>
      </OverlayPanel>,
    );
    const frame = ui.lastFrame() ?? '';
    ui.unmount();

    expect(stripAnsiStyles(frame)).toContain(title);

    // With color disabled (FORCE_COLOR=0) Ink emits no ANSI prefixes, so `accentOpen`/`dimOpen`
    // are empty and there is no styling to inspect — the stripped-text check above is the only
    // available signal. Guard the prefix assertions to the color-on case where they are non-empty.
    if (accentOpen !== '') {
      expect(frame).toContain(dimOpen);
      expect(frame).not.toContain(accentOpen);
    }
  });
});

describe('OverlayPanel inner row capacity', () => {
  it('accounts for border and vertical padding in the frame row budget', () => {
    expect(OVERLAY_PANEL_FRAME_ROWS).toBe(4);
    expect(computeOverlayInnerRowCapacity({ terminalRows: 10, outerChromeRows: 4 })).toBe(2);
    expect(computeOverlayInnerRowCapacity({ terminalRows: 4, outerChromeRows: 4 })).toBe(0);
  });
});

describe('OverlayPanel inner width', () => {
  beforeEach(() => {
    terminalSizeStore.__testReset({ cols: 20, rows: 8, isSmall: true });
  });

  it('keeps child content inside the framed panel width', () => {
    const outerWidth = 12;
    const innerWidth = computeOverlayInnerWidth(outerWidth);
    const ui = render(
      <OverlayPanel maxWidth={outerWidth}>
        <Text>{'1'.repeat(innerWidth)}</Text>
      </OverlayPanel>,
    );

    const frame = stripAnsiStyles(ui.lastFrame() ?? '');
    ui.unmount();

    expect(innerWidth).toBe(6);
    expect(frame.split('\n').every((line) => line.length <= 20)).toBe(true);
    expect(frame).toMatch(/[│|] {2}111111 {2}[│|]/);
  });
});
