import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderFeature, tick } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import type { ConversationRow } from '../../conversation-rows/types.js';
import { glyph } from '../../../../lib/glyphs.js';
import { ConversationRowView } from './row-view.js';

const DONE_MARK = glyph('statusDone');
const ACTIVITY_DONE_MARK = glyph('stageDone');
const QUEUED_MARK = glyph('statusPending');
const LIVE_MARK = glyph('statusInProgress');
const FOCUS_MARK = glyph('liveBar');
const TREE_BRANCH_MARK = glyph('treeBranch');

function makeActivityRow(key: string): ConversationRow {
  return {
    key,
    kind: 'activity',
    segments: [{ text: 'reading src/a.ts', tone: 'textDim' }],
  };
}

function makeTaskHeaderRow(key: string): ConversationRow {
  return {
    key,
    kind: 'task-header',
    segments: [{ text: 'T001 No-op task', tone: 'text', bold: true }],
  };
}

describe('ConversationRowView lifecycle and focus glyphs', () => {
  it('renders the live ◉ for an active activity row and the done ● for a finished one', () => {
    const activeRow = makeActivityRow('activity-batch:0:call-1');

    const active = renderFeature(<ConversationRowView row={activeRow} lifecycle="live" />);
    const activeFrame = active.lastFrame() ?? '';
    expect(activeFrame).toContain(LIVE_MARK);
    expect(activeFrame).not.toContain(ACTIVITY_DONE_MARK);
    expect(activeFrame).toContain('reading src/a.ts');
    active.unmount();

    const steady = renderFeature(<ConversationRowView row={activeRow} lifecycle="done" />);
    const steadyFrame = steady.lastFrame() ?? '';
    expect(steadyFrame).toContain(ACTIVITY_DONE_MARK);
    expect(steadyFrame).not.toContain(LIVE_MARK);
    expect(steadyFrame).toContain('reading src/a.ts');
    steady.unmount();
  });

  it('renders the live ◉ for an active task-header row and the done ✓ for a finished one', () => {
    const row = makeTaskHeaderRow('task-header:T001');

    const active = renderFeature(<ConversationRowView row={row} lifecycle="live" />);
    const activeFrame = active.lastFrame() ?? '';
    expect(activeFrame).toContain(LIVE_MARK);
    expect(activeFrame).not.toContain(DONE_MARK);
    expect(activeFrame).toContain('T001 No-op task');
    active.unmount();

    const steady = renderFeature(<ConversationRowView row={row} lifecycle="done" />);
    const steadyFrame = steady.lastFrame() ?? '';
    expect(steadyFrame).toContain(DONE_MARK);
    expect(steadyFrame).not.toContain(LIVE_MARK);
    expect(steadyFrame).toContain('T001 No-op task');
    steady.unmount();
  });

  it('wears the ▌ accent bar on a focused transcript row', () => {
    const row = makeActivityRow('activity-batch:0:call-1');

    const focused = renderFeature(<ConversationRowView row={row} focused={true} />);
    const focusedFrame = focused.lastFrame() ?? '';
    expect(focusedFrame).toContain(FOCUS_MARK);
    expect(focusedFrame).toContain('reading src/a.ts');
    focused.unmount();

    const unfocused = renderFeature(<ConversationRowView row={row} focused={false} />);
    expect(unfocused.lastFrame() ?? '').not.toContain(FOCUS_MARK);
    unfocused.unmount();
  });

  it('never shows the ▌ focus bar and the live ◉ on the same row', () => {
    const row = makeActivityRow('activity-batch:0:call-1');

    const ui = renderFeature(<ConversationRowView row={row} lifecycle="live" focused={true} />);
    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain(LIVE_MARK);
    expect(frame).not.toContain(FOCUS_MARK);
    ui.unmount();
  });

  it('does not blink rows whose marker is not the activity dot', () => {
    const row: ConversationRow = {
      key: 'activity-more:0:call-1-hidden',
      kind: 'activity-more',
      segments: [{ text: '+1 more', tone: 'textDim' }],
    };

    const ui = renderFeature(<ConversationRowView row={row} lifecycle="live" />);
    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('+1 more');
    expect(frame).not.toContain('└');
    expect(frame).not.toContain('▸');
    expect(frame).not.toContain(LIVE_MARK);
    ui.unmount();
  });

  it('renders a static active bullet without blinking under reduce-motion', async () => {
    process.env.DIPTYCH_REDUCE_MOTION = '1';
    try {
      const row = makeActivityRow('activity-batch:0:call-1');
      const ui = renderFeature(<ConversationRowView row={row} lifecycle="live" />);
      const framesBefore = ui.frames.length;

      await tick(650);

      expect(ui.frames).toHaveLength(framesBefore);
      expect(ui.lastFrame() ?? '').toContain(LIVE_MARK);
      ui.unmount();
    } finally {
      delete process.env.DIPTYCH_REDUCE_MOTION;
    }
  });

  it('overlays the ▌ focus bar onto the done glyph cell of a focused completed header', () => {
    const row = makeTaskHeaderRow('task-header:T001');

    const ui = renderFeature(<ConversationRowView row={row} focused={true} />);
    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain(FOCUS_MARK);
    expect(frame).not.toContain(DONE_MARK);
    expect(frame).not.toContain(LIVE_MARK);
    expect(frame).toContain('T001 No-op task');
    ui.unmount();
  });

  it('keeps task-header row text aligned across focus changes', () => {
    const row = makeTaskHeaderRow('task-header:T001');
    const title = 'T001 No-op task';

    const focused = stripAnsiStyles(
      renderFeature(<ConversationRowView row={row} focused={true} />).lastFrame() ?? '',
    );
    const unfocused = stripAnsiStyles(
      renderFeature(<ConversationRowView row={row} focused={false} />).lastFrame() ?? '',
    );

    expect(focused.indexOf(title)).toBe(unfocused.indexOf(title));
    expect(focused.indexOf(title)).toBeGreaterThanOrEqual(0);
  });

  it('prepends the ▌ focus bar to a focused activity-child tree row', () => {
    const row: ConversationRow = {
      key: 'activity-child:0',
      kind: 'activity-child',
      segments: [{ text: 'reading src/b.ts', tone: 'textDim' }],
    };

    const ui = renderFeature(<ConversationRowView row={row} focused={true} />);
    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain(FOCUS_MARK);
    expect(frame).toContain(TREE_BRANCH_MARK);
    expect(frame).toContain('reading src/b.ts');
    ui.unmount();
  });
});

describe('ConversationRowView color-off degradation', () => {
  beforeEach(() => {
    process.env.NO_COLOR = '1';
  });
  afterEach(() => {
    delete process.env.NO_COLOR;
  });

  it('keeps live, done, and queued header states distinct by glyph, not color', () => {
    const header = makeActivityRow('activity-batch:0:call-1');

    const live = renderFeature(<ConversationRowView row={header} lifecycle="live" />);
    const done = renderFeature(<ConversationRowView row={header} lifecycle="done" />);
    const queued = renderFeature(<ConversationRowView row={header} lifecycle="queued" />);

    expect(live.lastFrame() ?? '').toContain(LIVE_MARK);
    expect(done.lastFrame() ?? '').toContain(ACTIVITY_DONE_MARK);
    expect(queued.lastFrame() ?? '').toContain(QUEUED_MARK);

    live.unmount();
    done.unmount();
    queued.unmount();
  });

  it('carries focus emphasis with the ▌ glyph, never weight alone', () => {
    const row = makeTaskHeaderRow('task-header:T001');

    const focused = renderFeature(<ConversationRowView row={row} focused={true} />);
    expect(focused.lastFrame() ?? '').toContain(FOCUS_MARK);
    focused.unmount();
  });
});
