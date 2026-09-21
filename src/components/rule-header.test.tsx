import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { forceUnicodeGlyphs } from '#testing/helpers/glyphs.js';
import { getTerminalCellWidth } from '../utils/display-text.js';
import { RuleHeader } from './rule-header.js';

const originalForceColor = vi.hoisted(() => {
  const saved = process.env['FORCE_COLOR'];
  process.env['FORCE_COLOR'] = '3';
  return saved;
});

afterAll(() => {
  if (originalForceColor === undefined) delete process.env['FORCE_COLOR'];
  else process.env['FORCE_COLOR'] = originalForceColor;
});

function lastAnsiBefore(frame: string, literal: string): string {
  const index = frame.indexOf(literal);
  if (index < 0) throw new Error(`expected frame to contain ${literal}`);
  const ansiPattern = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
  return [...frame.slice(0, index).matchAll(ansiPattern)].at(-1)?.[0] ?? '';
}

describe('RuleHeader', () => {
  beforeEach(() => {
    forceUnicodeGlyphs();
  });

  it('renders the label, a space, then dashes to the requested width', () => {
    const ui = render(<RuleHeader label="Mode" width={20} />);
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    expect(frame).toBe(`Mode ${'─'.repeat(15)}`);

    ui.unmount();
  });

  it('paints the label and the dashes in different colors', () => {
    const ui = render(<RuleHeader label="Mode" width={20} />);
    const raw = ui.lastFrame() ?? '';

    const labelColor = lastAnsiBefore(raw, 'Mode');
    const dashColor = lastAnsiBefore(raw, '─');
    expect(labelColor).not.toBe('');
    expect(dashColor).not.toBe('');
    expect(labelColor).not.toBe(dashColor);

    ui.unmount();
  });

  it('clamps dashes to zero and clips a label wider than the row', () => {
    const ui = render(<RuleHeader label="A very long label indeed" width={6} />);
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    expect(getTerminalCellWidth(frame)).toBeLessThanOrEqual(6);
    expect(frame).not.toContain('─');

    ui.unmount();
  });
});
