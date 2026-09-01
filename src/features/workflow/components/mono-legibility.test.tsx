import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { renderFeature } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { glyph } from '../../../lib/glyphs.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { overlayStore } from '../../../stores/ui/overlay.js';
import { eventRows } from '#testing/helpers/event-rows.js';
import { rowText } from '../conversation-rows/row-format/rows.js';
import type { EngineEventOf } from '../../../engine/events/types.js';
import { makeCostPrediction } from '#testing/helpers/factories/cost-prediction.js';
import type { StreamingOutputState } from '../../../stores/workflow/streaming-output.js';
import { taskId } from '../../../core/schemas/task.js';
import { CostApprovalPrompt } from './cost-approval-prompt.js';

// Stripping every ANSI style sequence reproduces exactly what a NO_COLOR / FORCE_COLOR=0 terminal
// paints: both hue (SGR colour) and the dimColor faint attribute are gone. What survives is the
// glyph and layout layer. These tests assert the redesign never lets required state ride on colour
// or dim alone — every state is also carried by a distinct shape, connector, border weight, or sign.

function monoFrame(frame: string | undefined): string {
  return stripAnsiStyles(frame ?? '');
}

beforeEach(() => {
  terminalSizeStore.__testReset({ cols: 100, rows: 40, isSmall: false });
  overlayStore.reset();
});

// NO_COLOR on a capable terminal: the glyph tier is still unicode (the terminal renders box
// drawing), only colour and faint are gone. Force the unicode tier so borderStyleFor('bold')
// emits the heavy frame, then strip ANSI to drop hue. (The non-TTY test default would otherwise
// resolve the ascii tier, where every border collapses to `classic` and the test would assert a
// degradation it is not trying to measure.)
describe('mono legibility — the cost approval gate without colour (unicode terminal)', () => {
  let restoreTTY: () => void;

  beforeEach(() => {
    const descriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    const prevTerm = process.env.TERM;
    const prevLang = process.env.LANG;
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    process.env.TERM = 'xterm-256color';
    process.env.LANG = 'en_US.UTF-8';
    restoreTTY = () => {
      if (descriptor) Object.defineProperty(process.stdout, 'isTTY', descriptor);
      if (prevTerm === undefined) delete process.env.TERM;
      else process.env.TERM = prevTerm;
      if (prevLang === undefined) delete process.env.LANG;
      else process.env.LANG = prevLang;
    };
  });

  afterEach(() => {
    restoreTTY();
  });

  it('keeps the bold gate border as a distinct heavy weight, never confused with round/single', () => {
    const ui = renderFeature(
      <CostApprovalPrompt
        prediction={makeCostPrediction()}
        onApprove={vi.fn()}
        onReject={vi.fn()}
      />,
    );
    const frame = monoFrame(ui.lastFrame());

    // "bold border = stop and decide" survives the strip because the heavy box glyphs are shape,
    // not colour. Round (╭) and single (┌) corners must never appear on a gate, or the heaviest
    // surface stops being recognisable once severity hue is gone.
    expect(frame).toContain('┃');
    expect(frame).toMatch(/[┏┓┗┛]/);
    expect(frame).not.toMatch(/[╭╮╰╯]/);
    expect(frame).not.toMatch(/[┌┐└┘]/);
    ui.unmount();
  });

  it('marks the default action with the ▸ cursor and keeps numbers as words, not hue', () => {
    const ui = renderFeature(
      <CostApprovalPrompt
        prediction={makeCostPrediction()}
        onApprove={vi.fn()}
        onReject={vi.fn()}
      />,
    );
    const frame = monoFrame(ui.lastFrame());

    // The approve action is the focused default: the ▸ cursor (not a hue) points at it.
    const cursor = glyph('cursor');
    const approveLine = frame.split('\n').find((row) => row.includes('Approve')) ?? '';
    expect(approveLine).toContain(cursor);
    expect(approveLine.indexOf(cursor)).toBeLessThan(approveLine.indexOf('Approve'));
    expect(frame).toContain('x   Deny');
    // The savings comparison reads as text/figures, so the "saving" emphasis (green in colour mode)
    // is not the only thing distinguishing it.
    expect(frame).toContain('$0.14');
    expect(frame).toContain('saving');
    ui.unmount();
  });
});

const streaming: StreamingOutputState = { taskId: null, lines: [], active: false };

function diffEvent(): EngineEventOf<'implementer_generate_done'> {
  return {
    type: 'implementer_generate_done',
    ts: 0,
    phase: 'implementing',
    taskId: taskId('T001'),
    file: 'src/auth/callback.ts',
    diff: '+ export async function handleCallback(req) {\n- return null',
    linesAdded: 1,
    linesRemoved: 1,
    duration: 1234,
  };
}

describe('mono legibility — the live diff and the live/cursor split without colour', () => {
  it('carries added/removed by the +/- sign in the row text, not only by green/red', () => {
    const rows = eventRows({
      event: diffEvent(),
      globalIndex: 0,
      expanded: true,
      ctx: { width: 80, viewportRows: 24, streaming },
    });
    const text = rows.map(rowText).join('\n');

    // The diff body keeps the leading +/-; with success/error tone stripped this sign is the only
    // remaining channel telling an addition from a removal.
    expect(text).toContain('+ export async function handleCallback');
    expect(text).toContain('- return null');
    // The header keeps signed counts too.
    expect(text).toContain('+1');
    expect(text).toContain('-1');
  });
});
