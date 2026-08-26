import type { ReactElement } from 'react';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import { beforeEach, describe, expect, it } from 'vitest';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { getTheme } from '../theme.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { overlayRect } from '../../core/navigation/overlay-rect.js';
import { OverlayPanel, overlayInnerRowCapacity } from './overlay-panel.js';

function colorOpen(color: string): string {
  const ui = render(<Text color={color}>x</Text>);
  const frame = ui.lastFrame() ?? '';
  ui.unmount();
  return frame.slice(0, frame.indexOf('x'));
}

function renderPanelLines(node: ReactElement): string[] {
  const ui = render(node);
  const frame = stripAnsiStyles(ui.lastFrame() ?? '');
  ui.unmount();
  return frame.split('\n');
}

function panelOuterWidth(lines: string[]): number {
  const topBorder = lines.find((line) => line.trim() !== '') ?? '';
  return topBorder.trim().length;
}

describe('OverlayPanel title', () => {
  beforeEach(() => {
    terminalSizeStore.__testReset({ cols: 80, rows: 24, isSmall: false });
  });

  // §1.1 accent budget: surface titles are quiet dim metadata; the lone accent per region is the
  // focused row's `▌` bar. A `·`-separated title must never accent its head (the prior regression).
  it.each(['help · commands & shortcuts'])('renders "%s" dim with no accent head', (title) => {
    const theme = getTheme('terminal');
    const accentOpen = colorOpen(theme.accent);
    const dimOpen = colorOpen(theme.textDim);

    const ui = render(
      <OverlayPanel title={title} density="roomy">
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
  it('leaves room for the frame rows and the gutter around the panel', () => {
    const capacity = (rows: number) => overlayInnerRowCapacity({ rows, outerChromeRows: 4 });

    expect(capacity(10)).toBe(2);
    expect(capacity(40)).toBe(30);
    expect(capacity(4)).toBe(0);
  });
});

describe('OverlayPanel sizing', () => {
  it('sizes the panel from its density and the terminal width', () => {
    terminalSizeStore.__testReset({ cols: 120, rows: 40, isSmall: false });
    const wide = renderPanelLines(
      <OverlayPanel density="roomy">
        <Text>body</Text>
      </OverlayPanel>,
    );
    expect(panelOuterWidth(wide)).toBe(84);

    terminalSizeStore.__testReset({ cols: 80, rows: 24, isSmall: false });
    const narrow = renderPanelLines(
      <OverlayPanel density="roomy">
        <Text>body</Text>
      </OverlayPanel>,
    );
    expect(panelOuterWidth(narrow)).toBe(76);
  });

  it('keeps child content inside the framed panel width', () => {
    terminalSizeStore.__testReset({ cols: 80, rows: 24, isSmall: false });
    const inner = overlayRect({ cols: 80, rows: 24, density: 'roomy' }).innerWidth;
    const lines = renderPanelLines(
      <OverlayPanel density="roomy">
        <Text>{'1'.repeat(inner)}</Text>
      </OverlayPanel>,
    );

    expect(inner).toBe(70);
    expect(lines.every((line) => line.length <= 80)).toBe(true);
    expect(lines.some((line) => line.includes('1'.repeat(inner)))).toBe(true);
  });
});

describe('OverlayPanel hint', () => {
  it('truncates an over-wide hint to a single row', () => {
    terminalSizeStore.__testReset({ cols: 60, rows: 18, isSmall: true });
    const hint = `esc close · ${'x'.repeat(51)}`;
    expect(hint.length).toBe(63);

    const lines = renderPanelLines(
      <OverlayPanel hint={hint} density="roomy">
        <Text>body</Text>
      </OverlayPanel>,
    );

    expect(lines.filter((line) => line.includes('x'))).toHaveLength(1);
    expect(lines.some((line) => line.includes(hint))).toBe(false);
  });
});
