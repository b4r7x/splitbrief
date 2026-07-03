import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { renderFeature, tick } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { glyph } from '../../../lib/glyphs.js';
import { lifecycleStore } from '../../../stores/workflow/lifecycle.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { eventsStore } from '../../../stores/workflow/events.js';
import { tasksStore } from '../../../stores/workflow/tasks.js';
import { tokensStore } from '../../../stores/workflow/tokens.js';
import { overlayStore } from '../../../stores/ui/overlay.js';
import { railConnectorString } from '../layout/chrome-rows.js';
import { eventRows } from '#testing/helpers/event-rows.js';
import { rowText } from '../conversation-rows/row-format.js';
import type { EngineEventOf } from '../../../engine/events/types.js';
import { makeCostPrediction } from '#testing/helpers/factories/cost-prediction.js';
import type { StreamingOutputState } from '../../../stores/workflow/streaming-output.js';
import { taskId } from '../../../core/schemas/task.js';
import { CostApprovalPrompt } from './cost-approval-prompt.js';

// Stripping every ANSI style sequence reproduces exactly what a NO_COLOR / FORCE_COLOR=0 terminal
// paints: both hue (SGR colour) and the dimColor faint attribute are gone. What survives is the
// glyph and layout layer. These tests assert the redesign never lets required state ride on colour
// or dim alone — every state is also carried by a distinct shape, connector, border weight, or sign.

const ACTIVE = glyph('stageActive');
const DONE = glyph('stageDone');
const PENDING = glyph('stagePending');

function monoFrame(frame: string | undefined): string {
  return stripAnsiStyles(frame ?? '');
}

beforeEach(() => {
  lifecycleStore.__testReset();
  terminalSizeStore.__testReset({ cols: 100, rows: 40, isSmall: false });
  eventsStore.__testReset();
  tasksStore.__testReset();
  tokensStore.__testReset();
  overlayStore.reset();
});

describe('mono legibility — the pipeline rail without colour', () => {
  it('encodes each stage state by shape alone (○ pending / ◉ active / ● done)', async () => {
    lifecycleStore.__testReset({ phase: 'implementing', status: 'running', startedAt: 0 });
    tasksStore.__testReset({ currentTask: 3, totalTasks: 7 });
    const { Rail } = await import('./rail.js');
    const ui = renderFeature(<Rail form="B" />);
    await tick();
    const frame = monoFrame(ui.lastFrame());
    const railLine = frame.split('\n').find((row) => row.includes('spec')) ?? '';

    // The three marker shapes are mutually distinct and each still binds to its stage by position,
    // so progress reads with hue and faint both stripped.
    expect(new Set([PENDING, ACTIVE, DONE]).size).toBe(3);
    expect(railLine).toContain(`${DONE} spec`);
    expect(railLine).toContain(`${ACTIVE} build`);
    expect(railLine).toContain(`${PENDING} verify`);
    // Exactly one stage is active — not inferable from a hue/bold that the strip removed.
    expect(railLine.split(ACTIVE).length - 1).toBe(1);
    ui.unmount();
  });

  it('encodes the planner→implementer handoff by connector shape (› same-role / → seam)', async () => {
    lifecycleStore.__testReset({ phase: 'implementing', status: 'running', startedAt: 0 });
    tasksStore.__testReset({ currentTask: 3, totalTasks: 7 });
    const { Rail } = await import('./rail.js');
    const ui = renderFeature(<Rail form="B" />);
    await tick();
    const railLine =
      monoFrame(ui.lastFrame())
        .split('\n')
        .find((row) => row.includes('spec')) ?? '';

    const handoff = railConnectorString(true);
    const sameRole = railConnectorString(false);
    expect(handoff).not.toBe(sameRole);
    // Two role seams (briefs→build, build→verify), two same-role gaps — the cost handoff is the
    // arrow, and it stays the arrow once the hue that also marks it is stripped.
    expect(railLine.split(handoff).length - 1).toBe(2);
    expect(railLine.split(sameRole).length - 1).toBe(2);
    ui.unmount();
  });
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
    expect(cursor).toBe('▸');
    const approveLine = frame.split('\n').find((row) => row.includes('approve?')) ?? '';
    expect(approveLine).toContain(cursor);
    expect(approveLine.indexOf(cursor)).toBeLessThan(approveLine.indexOf('approve?'));
    expect(frame).toContain('reject');
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

  it('keeps "this is live" (▌) shape-distinct from "your cursor is here" (▸)', () => {
    // The two restored selection meanings must not collapse to a single mark, or in mono a live
    // row and a focused row become indistinguishable.
    expect(glyph('liveBar')).not.toBe(glyph('cursor'));
    expect(glyph('liveBar').length).toBeGreaterThan(0);
    expect(glyph('cursor').length).toBeGreaterThan(0);
  });
});
