import type { ReactElement } from 'react';
import { Box } from 'ink';
import { render } from 'ink-testing-library';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { glyph } from '../lib/glyphs.js';
import { ListGroupHeader, ListRow, listRowLead } from './list-row.js';

const originalForceColor = vi.hoisted(() => {
  const saved = process.env['FORCE_COLOR'];
  process.env['FORCE_COLOR'] = '3';
  return saved;
});

afterAll(() => {
  if (originalForceColor === undefined) delete process.env['FORCE_COLOR'];
  else process.env['FORCE_COLOR'] = originalForceColor;
});

const envSnapshot = { ...process.env };
let ttyDescriptor: PropertyDescriptor | undefined;

function forceUnicodeGlyphs(): void {
  process.env.TERM = 'xterm-256color';
  process.env.LANG = 'en_US.UTF-8';
  ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
}

function withAsciiTier(run: () => void): void {
  process.env.TERM = 'dumb';
  try {
    run();
  } finally {
    process.env = { ...envSnapshot };
    if (ttyDescriptor) {
      Object.defineProperty(process.stdout, 'isTTY', ttyDescriptor);
    } else {
      forceUnicodeGlyphs();
    }
  }
}

/** The SGR parameters a run of text is painted with, read from the escape that opens it. */
function colorOf(frame: string, text: string): string | undefined {
  const before = frame.split(text)[0];
  return before?.split('\u001B[').at(-1)?.split('m')[0];
}

function frameOf(node: ReactElement, width = 40): string {
  const ui = render(
    <Box width={width} flexDirection="column">
      {node}
    </Box>,
  );
  const frame = ui.lastFrame() ?? '';
  ui.unmount();
  return frame;
}

describe('ListRow', () => {
  beforeEach(() => {
    forceUnicodeGlyphs();
  });

  it('exports listRowLead', () => {
    expect(listRowLead('active')).toBe(`${glyph('liveBar')} `);
    expect(listRowLead('context')).toBe(`${glyph('liveBar')} `);
    expect(listRowLead('default')).toBe('  ');
  });

  it('elides a path label at a separator, so what is left is still a whole path', () => {
    const label = 'kilo/anthropic/claude-opus-4.5';
    const wide = stripAnsiStyles(
      frameOf(<ListRow label={label} labelTruncate="path" width={40} />),
    );
    const narrow = stripAnsiStyles(
      frameOf(<ListRow label={label} labelTruncate="path" width={24} />),
    );

    expect(wide).toContain(label);
    expect(narrow).toContain('…/claude-opus-4.5');
    expect(narrow).not.toContain('anthropic');
  });

  it('renders a default row with no focus or active glyph', () => {
    const frame = frameOf(<ListRow label="claude code" />);
    expect(frame).toContain('claude code');
    expect(frame).not.toContain('▌');
    expect(frame).not.toContain('▸');
  });

  it('renders state context with the liveBar glyph in dim lead and default text colors', () => {
    const activeFrame = frameOf(
      <ListRow label="claude code" state="active" metadata="active-meta" />,
    );
    const contextFrame = frameOf(
      <ListRow label="claude code" state="context" metadata="active-meta" />,
    );

    // ANSI-stripped equality of glyph and structure between context and active
    expect(stripAnsiStyles(contextFrame)).toContain(glyph('liveBar'));
    expect(stripAnsiStyles(contextFrame)).toBe(stripAnsiStyles(activeFrame));

    // Differing color codes between context and active
    expect(contextFrame).not.toBe(activeFrame);

    // The active row paints its lead and its label with one accent; the context
    // row dims the lead to the metadata's ink and leaves the label alone.
    const activeLead = colorOf(activeFrame, glyph('liveBar'));
    const contextLead = colorOf(contextFrame, glyph('liveBar'));
    expect(contextLead).not.toBe(activeLead);
    expect(colorOf(activeFrame, 'claude code')).toBe(activeLead);
    expect(colorOf(contextFrame, 'active-meta')).toBe(contextLead);
    expect(colorOf(contextFrame, 'claude code')).not.toBe(contextLead);
  });

  it('uses the ascii live bar for state context when the glyph tier is ascii', () => {
    withAsciiTier(() => {
      const frame = frameOf(<ListRow label="codex" state="context" />);
      expect(stripAnsiStyles(frame)).toContain(`${glyph('liveBar', 'ascii')} `);
      expect(frame).not.toContain('▌');
    });
  });

  it('renders a · middot lead for the dot default variant', () => {
    const frame = frameOf(<ListRow label="codex" defaultLead="dot" />);
    expect(frame).toContain('·');
    expect(frame).toContain('codex');
    expect(frame).not.toContain('▌');
    expect(frame).not.toContain('▸');
  });

  it('keeps the active glyph over the dot lead when focused', () => {
    const frame = frameOf(<ListRow label="codex" state="active" defaultLead="dot" />);
    expect(frame).toContain('▌');
    expect(frame).not.toContain('·');
  });

  it('marks an active row with the ▌ accent bar only', () => {
    const frame = frameOf(<ListRow label="sonnet 4.5" state="active" />);
    expect(frame).toContain('▌');
    expect(frame).not.toContain('▸');
  });

  it('uses the ascii live bar when the glyph tier is ascii', () => {
    withAsciiTier(() => {
      const frame = frameOf(<ListRow label="codex" state="active" />);
      expect(frame).toContain(`${glyph('liveBar', 'ascii')} `);
      expect(frame).not.toContain('▌');
    });
  });

  it('renders dim metadata after the label', () => {
    const frame = frameOf(<ListRow label="sonnet 4.5" metadata="200k" />);
    expect(frame).toContain('sonnet 4.5');
    expect(frame).toContain('200k');
  });

  it('reserves a blank 2-cell check column when selected is false', () => {
    const withoutCheckColumn = stripAnsiStyles(
      frameOf(<ListRow label="tool" metadata="1.2" width={24} />, 24),
    );
    const withBlankCheckColumn = stripAnsiStyles(
      frameOf(<ListRow label="tool" metadata="1.2" selected={false} width={24} />, 24),
    );

    expect(withBlankCheckColumn).not.toContain(glyph('check'));
    expect(withBlankCheckColumn.indexOf('1.2')).toBe(withoutCheckColumn.indexOf('1.2') - 2);
  });

  it('renders metadata flush right with the check column when selected', () => {
    const line = stripAnsiStyles(
      frameOf(<ListRow label="tool" metadata="1.2" selected width={24} />, 24).split('\n')[0] ?? '',
    );

    expect(line.trimEnd().endsWith(`1.2 ${glyph('check')}`)).toBe(true);
  });

  it('truncates label with … when width overflows', () => {
    const line = stripAnsiStyles(
      frameOf(<ListRow label="a very long label that overflows" width={14} />, 40).split('\n')[0] ??
        '',
    );

    expect(line).toContain('…');
    expect(line).not.toContain('overflows');
  });

  it('long metadata renders with a trailing `…`', () => {
    const line = stripAnsiStyles(
      frameOf(
        <ListRow
          label="/palette"
          metadata="a very long description that cannot possibly fit on one short row"
          width={40}
        />,
        40,
      ).split('\n')[0] ?? '',
    );

    expect(line).toContain('…');
    expect(line).not.toContain('short row');
  });

  it('right-aligns dim trailing metadata at the row edge', () => {
    const frame = frameOf(
      <ListRow label="/settings" metadata="planner & model" trailing="ctrl+," labelWidth={12} />,
      40,
    );
    const line = frame.split('\n')[0] ?? '';
    expect(line).toContain('/settings');
    expect(line).toContain('planner & model');
    expect(stripAnsiStyles(line).trimEnd().endsWith('ctrl+,')).toBe(true);
  });

  it('keeps the trailing key visible while truncating an overflowing description', () => {
    const frame = frameOf(
      <ListRow
        label="/settings"
        metadata="a very long description that cannot possibly fit on one short row"
        trailing="ctrl+,"
        labelWidth={12}
      />,
      40,
    );
    expect(frame).toContain('ctrl+,');
    expect(frame).toContain('…');
    expect(stripAnsiStyles(frame.split('\n')[0] ?? '').length).toBeLessThanOrEqual(40);
  });

  it('renders a trailing ✓ only when selected', () => {
    expect(frameOf(<ListRow label="opus 4.1" selected />)).toContain(glyph('check'));
    expect(frameOf(<ListRow label="opus 4.1" />)).not.toContain(glyph('check'));
  });

  it('uses the ascii check mark when a selected row renders in the ascii tier', () => {
    withAsciiTier(() => {
      const frame = frameOf(<ListRow label="opus 4.1" selected />);
      expect(frame).toContain(glyph('check', 'ascii'));
      expect(frame).not.toContain('✓');
    });
  });

  it('right-aligns the multi-select ✓ at the row edge even without trailing metadata', () => {
    const frame = frameOf(
      <ListRow label="security-review" metadata="auth, secrets" selected labelWidth={20} />,
      60,
    );
    const line = stripAnsiStyles(frame.split('\n')[0] ?? '');
    expect(line.trimEnd().endsWith(glyph('check'))).toBe(true);
  });

  it('stays one line tall and strips terminal controls', () => {
    const frame = frameOf(<ListRow label={'A\x1b[31m\nB'} metadata="meta" />);
    expect(frame).toContain('AB');
    expect(frame).toContain('meta');
    expect(frame).not.toContain('\x1b[31m');
    expect(frame.split('\n')).toHaveLength(1);
  });

  it('keeps the same frame length when a tree lead is paid for from the label budget', () => {
    const withoutTree = stripAnsiStyles(
      frameOf(<ListRow label="effort" selected={false} trailing={' '} width={40} />, 40).split(
        '\n',
      )[0] ?? '',
    );
    const withTree = stripAnsiStyles(
      frameOf(
        <ListRow label="effort" treeLead="├─ " selected={false} trailing={' '} width={40} />,
        40,
      ).split('\n')[0] ?? '',
    );

    expect(withTree.length).toBe(withoutTree.length);
    expect(withoutTree.endsWith('  ')).toBe(true);
    expect(withTree.endsWith('  ')).toBe(true);
  });

  it('draws the tree lead between the gutter and the label', () => {
    const frame = stripAnsiStyles(
      frameOf(<ListRow label="effort" treeLead="AB " width={40} />, 40).split('\n')[0] ?? '',
    );

    expect(frame).toContain('AB ');
    expect(frame.indexOf('effort')).toBeGreaterThan(frame.indexOf('AB'));
  });

  it('truncates long metadata instead of overflowing when a tree lead is present', () => {
    const line = stripAnsiStyles(
      frameOf(
        <ListRow
          label="effort"
          treeLead="│  ├─ "
          metadata="a very long description that cannot possibly fit on one short row"
          width={24}
        />,
        24,
      ).split('\n')[0] ?? '',
    );

    expect(line.length).toBeLessThanOrEqual(24);
    expect(line).toContain('…');
  });

  it('keeps a tree row metadata visible at a 21-cell width', () => {
    const withTree = stripAnsiStyles(
      frameOf(
        <ListRow
          label="effort"
          treeLead="│  ├─ "
          metadata="high"
          selected={false}
          trailing={' '}
          width={21}
        />,
        21,
      ).split('\n')[0] ?? '',
    );
    const withoutTree = stripAnsiStyles(
      frameOf(
        <ListRow label="effort" metadata="high" selected={false} trailing={' '} width={21} />,
        21,
      ).split('\n')[0] ?? '',
    );

    expect(withTree).toContain('h');
    expect(withoutTree).toContain('high');
  });

  it('does not change cell text when metadataColor is set', () => {
    const withoutColor = stripAnsiStyles(
      frameOf(<ListRow label="tool" metadata="warn" width={40} />, 40),
    );
    const withColor = stripAnsiStyles(
      frameOf(<ListRow label="tool" metadata="warn" metadataColor="#ffcc00" width={40} />, 40),
    );

    expect(withColor).toBe(withoutColor);
  });
});

describe('ListGroupHeader', () => {
  it('renders a dim single-line header without a row lead', () => {
    const frame = frameOf(<ListGroupHeader label="commands" />);
    expect(frame).toContain('commands');
    expect(frame).not.toContain('▌');
    expect(frame).not.toContain('▸');
    expect(frame.split('\n')).toHaveLength(1);
  });

  it('strips terminal controls from the header label', () => {
    const frame = frameOf(<ListGroupHeader label={'mo\x1b[31mdes'} />);
    expect(frame).toContain('modes');
    expect(frame).not.toContain('\x1b[31m');
  });
});
