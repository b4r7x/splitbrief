import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Box } from 'ink';
import { renderFeature } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { glyph } from '../lib/glyphs.js';
import { makeSession } from '#testing/helpers/factories/session.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { SessionRow } from './session-row.js';

const CURSOR_GLYPH = '▸';
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

function frameOf(element: Parameters<typeof renderFeature>[0]): string {
  const ui = renderFeature(element);
  const frame = stripAnsiStyles(ui.lastFrame() ?? '');
  ui.unmount();
  return frame;
}

function nonBlankLines(frame: string): number {
  return frame.split('\n').filter((line) => line.trim().length > 0).length;
}

function lineContaining(frame: string, text: string): string {
  const line = frame.split('\n').find((candidate) => candidate.includes(text));
  expect(line).toBeDefined();
  return line ?? '';
}

describe('SessionRow', () => {
  beforeEach(() => {
    resetAllStores();
    forceUnicodeGlyphs();
  });

  afterEach(() => {
    resetAllStores();
  });

  it('renders the relative-time string across every if-ladder boundary of formatRelativeTime', () => {
    const now = Date.now();
    const cases: Array<[number, string]> = [
      [30_000, 'just now'],
      [60_000, '1m ago'],
      [59 * 60_000, '59m ago'],
      [60 * 60_000, '1h ago'],
      [23 * 3_600_000, '23h ago'],
      [24 * 3_600_000, '1d ago'],
      [3 * 86_400_000, '3d ago'],
    ];

    for (const [offset, expected] of cases) {
      const frame = frameOf(<SessionRow session={makeSession({ startedAt: now - offset })} />);
      expect(frame).toContain(expected);
    }
  });

  it("renders 'just now' for non-finite startedAt (NaN, Infinity, -Infinity)", () => {
    for (const startedAt of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const frame = frameOf(<SessionRow session={makeSession({ startedAt })} />);
      expect(frame).toContain('just now');
    }
  });

  it('truncates a long feature inside a narrow container and renders it fully when wide', () => {
    const longFeature = 'a-very-long-feature-name-that-overflows';
    const now = Date.now();

    const truncated = frameOf(
      <Box width={40}>
        <SessionRow session={makeSession({ feature: longFeature, startedAt: now })} />
      </Box>,
    );
    expect(truncated).toContain('…');
    expect(truncated).not.toContain('overflows');
    expect(nonBlankLines(truncated)).toBe(1);

    const untruncated = frameOf(
      <Box width={80}>
        <SessionRow session={makeSession({ feature: longFeature, startedAt: now })} />
      </Box>,
    );
    expect(untruncated).toContain(`○ ${longFeature}`);
    expect(untruncated).not.toContain('…');
  });

  it('shows an ellipsis when a long multi-word feature is truncated to the row width', () => {
    const feature = 'prosze pokaz mi to ze to dziala, po prostu zrob test i nic wiecej i jeszcze';
    const frame = frameOf(
      <Box width={50}>
        <SessionRow
          session={makeSession({ feature, startedAt: Date.now() })}
          cursor={{ kind: 'inline', isCursor: true }}
        />
      </Box>,
    );
    expect(frame).toContain('…');
    expect(frame).not.toContain('jeszcze');
    expect(frame).toMatch(/… 1m ago|… just now/);
  });

  it('keeps a focused row on one line and does not shift columns when selected', () => {
    const longFeature = 'a-very-long-feature-name-that-would-overflow-a-narrow-body';
    const session = makeSession({ feature: longFeature, startedAt: Date.now() });

    const unselected = frameOf(
      <Box width={72}>
        <SessionRow session={session} cursor={{ kind: 'inline', isCursor: false }} />
      </Box>,
    );
    const selected = frameOf(
      <Box width={72}>
        <SessionRow session={session} cursor={{ kind: 'inline', isCursor: true }} />
      </Box>,
    );

    expect(nonBlankLines(unselected)).toBe(1);
    expect(nonBlankLines(selected)).toBe(1);
    const marker = longFeature.slice(0, 6);
    expect(selected.indexOf(marker)).toBe(unselected.indexOf(marker));
  });

  it('marks the selected inline row with a ▌ accent lead and reserves the cell otherwise', () => {
    const session = makeSession({ feature: 'alpha', startedAt: Date.now() });

    const selected = frameOf(
      <Box width={72}>
        <SessionRow session={session} cursor={{ kind: 'inline', isCursor: true }} />
      </Box>,
    );
    const unselected = frameOf(
      <Box width={72}>
        <SessionRow session={session} cursor={{ kind: 'inline', isCursor: false }} />
      </Box>,
    );

    expect(selected).toContain('▌');
    expect(unselected).not.toContain('▌');
    expect(selected.indexOf('alpha')).toBe(unselected.indexOf('alpha'));
  });

  it('renders the status icon for each session status', () => {
    expect(frameOf(<SessionRow session={makeSession({ status: 'complete' })} />)).toContain('✓');
    expect(
      frameOf(<SessionRow session={makeSession({ status: 'interrupted', summary: null })} />),
    ).toContain('○');
  });

  it('renders a failed session with a dim ○ lead and a dim-red "failed" word, never a ✗ glyph', () => {
    const frame = frameOf(
      <SessionRow
        session={makeSession({ status: 'failed', feature: 'flaky-test', summary: null })}
      />,
    );
    expect(frame).not.toContain('✗');
    expect(lineContaining(frame, 'flaky-test')).toMatch(/^○ flaky-test/);
    expect(frame).toContain('failed');
  });

  it('does not reserve a cursor cell when no cursor is requested', () => {
    const frame = frameOf(<SessionRow session={makeSession({ feature: 'alpha' })} />);
    expect(lineContaining(frame, 'alpha')).toMatch(/^○ alpha/);
  });

  it('uses the ▌ accent bar as the sole inline selection signal, never the ▸ cursor', () => {
    const defaults = frameOf(<SessionRow session={makeSession()} />);
    expect(defaults).not.toContain(CURSOR_GLYPH);

    const active = frameOf(
      <SessionRow session={makeSession()} cursor={{ kind: 'inline', isCursor: true }} />,
    );
    expect(active).not.toContain(CURSOR_GLYPH);
    expect(active).toContain('▌');

    const inactive = frameOf(
      <SessionRow session={makeSession()} cursor={{ kind: 'inline', isCursor: false }} />,
    );
    expect(inactive).not.toContain(CURSOR_GLYPH);
    expect(inactive).not.toContain('▌');
  });

  it('uses ascii status and selection markers when the glyph tier is ascii', () => {
    withAsciiTier(() => {
      const frame = frameOf(
        <SessionRow
          session={makeSession({ feature: 'ascii-task', status: 'interrupted', summary: null })}
          cursor={{ kind: 'inline', isCursor: true }}
        />,
      );
      expect(frame).toContain(`${glyph('liveBar', 'ascii')} `);
      expect(frame).toContain(`${glyph('statusPending', 'ascii')} ascii-task`);
      expect(frame).not.toContain('▌');
      expect(frame).not.toContain('○');
    });
  });

  it('strips OSC-52/CSI control bytes from a persisted session feature name', () => {
    const payload = 'ZWNobyBwd25lZA==';
    const malicious = `before\u001b]52;c;${payload}\u0007\u001b[2Jafter`;
    const ui = renderFeature(
      <Box width={80}>
        <SessionRow session={makeSession({ feature: malicious, startedAt: Date.now() })} />
      </Box>,
    );
    const rawFrame = ui.lastFrame() ?? '';
    ui.unmount();

    expect(rawFrame).not.toContain(payload);
    expect(rawFrame).not.toContain('\u001b]52');
    expect(rawFrame).not.toContain('\u001b[2J');
    expect(stripAnsiStyles(rawFrame)).toContain('beforeafter');
  });

  it('leads an outdented row with the ▌ accent bar, never the ▸ cursor, without shifting the feature', () => {
    const session = makeSession({ feature: 'alpha', startedAt: Date.now() });
    const plain = frameOf(
      <Box marginLeft={4} width={72}>
        <SessionRow session={session} />
      </Box>,
    );
    const outdented = frameOf(
      <Box marginLeft={4} width={72}>
        <SessionRow session={session} cursor={{ kind: 'outdent', isCursor: true }} />
      </Box>,
    );

    const plainAlpha = lineContaining(plain, 'alpha').indexOf('alpha');
    const outdentedLine = lineContaining(outdented, 'alpha');
    expect(outdented).not.toContain(CURSOR_GLYPH);
    expect(outdentedLine.indexOf('alpha')).toBe(plainAlpha);
    expect(outdentedLine.indexOf('▌')).toBeLessThan(outdentedLine.indexOf('○ alpha'));
  });
});
