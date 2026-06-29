import type { ReactElement } from 'react';
import { Box } from 'ink';
import { render } from 'ink-testing-library';
import { beforeEach, describe, expect, it } from 'vitest';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { glyph } from '../lib/glyphs.js';
import { ListGroupHeader, ListRow } from './list-row.js';

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

  it('renders a default row with no focus or active glyph', () => {
    const frame = frameOf(<ListRow label="claude code" />);
    expect(frame).toContain('claude code');
    expect(frame).not.toContain('▌');
    expect(frame).not.toContain('▸');
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
