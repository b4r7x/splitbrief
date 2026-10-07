import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { flushEffects, renderFeature, tick } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { glyph } from '../../../lib/glyphs.js';
import { listRowLead } from '../../../components/list-row.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { overlayStore } from '../../../stores/ui/overlay.js';
import { eventRows } from '#testing/helpers/event-rows.js';
import { rowText } from '../conversation-rows/row-format/rows.js';
import type { EngineEventOf } from '../../../engine/events/types.js';
import type { StreamingOutputState } from '../../../stores/workflow/streaming-output.js';
import { taskId } from '../../../core/schemas/task.js';
import { ApprovalPrompt } from './approval-prompt.js';
import { approvalPromptStore, openApprovalPrompt } from '../../../stores/approval-prompt/prompt.js';
import type { TieredApprovalRequest } from '../../../core/approval/types.js';

// Stripping every ANSI style sequence reproduces exactly what a NO_COLOR / FORCE_COLOR=0 terminal
// paints: hue (SGR colour) is gone. What survives is the
// glyph and layout layer. These tests assert the redesign never lets required state ride on colour
// or dim alone — every state is also carried by a distinct shape, connector, border weight, or sign.

function monoFrame(frame: string | undefined): string {
  return stripAnsiStyles(frame ?? '');
}

function confirmRequest(): TieredApprovalRequest {
  return {
    tier: 'confirm',
    actionClass: 'destructive',
    actionDescription: '.splitbrief/state.json',
    phase: 'implementing',
  };
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
describe('mono legibility — the tiered approval gate without colour (unicode terminal)', () => {
  let restoreTTY: () => void;

  beforeEach(() => {
    approvalPromptStore.__testReset();
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
    approvalPromptStore.__testReset();
  });

  it('keeps the bold gate border as a distinct heavy weight, never confused with round/single', async () => {
    const ui = renderFeature(<ApprovalPrompt />);
    void openApprovalPrompt(confirmRequest());
    await tick(1);
    await flushEffects();
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

  it('marks the default action with the accent lead bar, not a hue', async () => {
    const ui = renderFeature(<ApprovalPrompt />);
    void openApprovalPrompt(confirmRequest());
    await tick(1);
    await flushEffects();
    const frame = monoFrame(ui.lastFrame());

    const bar = listRowLead('active');
    const confirmLine = frame.split('\n').find((row) => row.includes('Confirm')) ?? '';
    expect(confirmLine).toContain(bar);
    expect(confirmLine.indexOf(bar)).toBeLessThan(confirmLine.indexOf('Confirm'));
    // A destructive Confirm row carries no accelerator, so the key cell is blank; the row after
    // it sets the column with its single letter.
    expect(confirmLine).not.toContain('enter');
    expect(frame).toContain('r   Confirm with a reason');
    expect(frame).not.toContain(glyph('cursor'));
    expect(frame).toContain('Deny');
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
