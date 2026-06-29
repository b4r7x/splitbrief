import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderFeature, tick } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import {
  makePlannerText as makePlannerTextEvent,
  makeTaskStart,
  makeTaskComplete,
  makeImplementerGenerate,
} from '#testing/helpers/events.js';
import { conversationScrollStore } from '../../../../stores/workflow/conversation-scroll.js';
import { streamingOutputStore } from '../../../../stores/workflow/streaming-output.js';
import { eventsStore } from '../../../../stores/workflow/events.js';
import { lifecycleStore } from '../../../../stores/workflow/lifecycle.js';
import { tasksStore } from '../../../../stores/workflow/tasks.js';
import { addEvent } from '../../../../stores/workflow/actions.js';
import { taskId } from '../../../../core/schemas/task.js';
import type { EngineEvent } from '../../../../engine/events/types.js';
import type { ConversationRow } from '../../conversation-rows/types.js';
import { getTheme } from '../../../../components/theme.js';
import { glyph } from '../../../../lib/glyphs.js';
import { ConversationFlow } from './flow.js';
import { ConversationRowView, colorForTone } from './row-view.js';
import { hoverStore } from '../../../../stores/ui/hover.js';
import * as projectionCache from '../../conversation-rows/projection-cache.js';

const DONE_MARK = glyph('statusDone');
const ACTIVITY_DONE_MARK = glyph('stageDone');
const QUEUED_MARK = glyph('statusPending');
const LIVE_MARK = glyph('statusInProgress');
const FOCUS_MARK = glyph('liveBar');
const TREE_BRANCH_MARK = glyph('treeBranch');

function makePlannerText(index: number): Extract<EngineEvent, { type: 'planner_text' }> {
  return makePlannerTextEvent({ ts: index, phase: 'planning', text: `event ${index}` });
}

function makePlannerTextBlock(lines: number): Extract<EngineEvent, { type: 'planner_text' }> {
  return makePlannerTextEvent({
    ts: 0,
    phase: 'planning',
    text: Array.from({ length: lines }, (_, index) => `line-${index + 1}`).join('\n'),
  });
}

function makeMarkdownPlannerText(): Extract<EngineEvent, { type: 'planner_text' }> {
  return makePlannerTextEvent({
    ts: 0,
    phase: 'planning',
    content: 'markdown',
    text: [
      'id: T001',
      'title: Run no-op validation smoke check',
      'action: modify',
      'file: package.json',
      'depends_on: []',
      '---',
      '',
      '### Description',
      'Run a quick validation-only smoke check.',
      '',
      '### Signature',
      '```typescript',
      '// No exported signature.',
      '```',
    ].join('\n'),
  });
}

function makeLiveTaskBriefPlannerText(): Extract<EngineEvent, { type: 'planner_text' }> {
  return makePlannerTextEvent({
    ts: 0,
    phase: 'researching',
    role: 'planner',
    text: [
      '---',
      'id: T018',
      'title: Render live task brief markdown',
      'action: modify',
      'file: src/features/workflow/components/conversation-flow/flow.test.tsx',
      'depends_on: []',
      '---',
      '',
      '### Description',
      'Render the same live frame users see.',
      '',
      '### Signature',
      '```ts',
      'export function renderLiveBrief(): void',
      '```',
      '',
      '### Validation',
      '```yaml',
      'scripts:',
      '  typecheck: npm run typecheck',
      '```',
    ].join('\n'),
  });
}

function makeLongTaskStarted(): Extract<EngineEvent, { type: 'task_started' }> {
  return makeTaskStart({
    ts: 0,
    title: 'No-op workflow demonstration with enough metadata to wrap',
    total: 1,
    file: 'README.md',
    tool: 'claude-code',
    model: 'sonnet',
    implementerProfile: 'default',
    contextFit: 'fits',
    estimatedTokens: 3911,
    contextLength: 32768,
    currentCodeContextMode: 'whole-file',
    costPosture: 'Selected unknown cost tier via cheapest-capable routing',
  });
}

function makeRunningImplementer(): Extract<EngineEvent, { type: 'implementer_generate_running' }> {
  return makeImplementerGenerate({ status: 'running', ts: 0, file: 'README.md' });
}

function makeTaskCompleted(): Extract<EngineEvent, { type: 'task_completed' }> {
  return makeTaskComplete({ ts: 0, title: 'Finished task', duration: 1 });
}

function makeTaskFullFail(): Extract<EngineEvent, { type: 'task_full_fail' }> {
  return {
    type: 'task_full_fail',
    ts: 0,
    phase: 'implementing',
    taskId: taskId('T001'),
  };
}

function makeRunnerActivity(): Extract<EngineEvent, { type: 'runner_call_activity' }> {
  return {
    type: 'runner_call_activity',
    ts: 0,
    phase: 'researching',
    callId: 'call-1',
    role: 'planner',
    backendKind: 'cli',
    runnerName: 'codex',
    sequence: 2,
    activityId: 'call-1:system',
    stage: 'updated',
    kind: 'unknown',
    label: '/bin/zsh -lc "sed -n \'1,260p\' CLAUDE.md"',
    redacted: false,
  };
}

function makeActivityRead(
  sequence: number,
  file: string,
): Extract<EngineEvent, { type: 'runner_call_activity' }> {
  return {
    type: 'runner_call_activity',
    ts: sequence,
    phase: 'researching',
    callId: 'call-1',
    role: 'planner',
    backendKind: 'cli',
    runnerName: 'codex',
    sequence,
    activityId: `call-1:read:${file}`,
    stage: 'completed',
    kind: 'read',
    label: `reading ${file}`,
    redacted: false,
  };
}

function makeActivityReads(
  files: string[],
): Extract<EngineEvent, { type: 'runner_call_activity' }>[] {
  return files.map((file, index) => makeActivityRead(index + 1, file));
}

function makeActivityReadForCall(
  sequence: number,
  callId: string,
  file: string,
): Extract<EngineEvent, { type: 'runner_call_activity' }> {
  return {
    ...makeActivityRead(sequence, file),
    callId,
    activityId: `${callId}:read:${file}`,
  };
}

function frameRowCount(frame: string): number {
  return frame.length === 0 ? 0 : frame.split('\n').length;
}

function normalizedRows(frame: string): string[] {
  return windowRows(frame).filter((line) => line !== '');
}

function windowRows(frame: string): string[] {
  return stripAnsiStyles(frame)
    .split('\n')
    .map((line) => line.trim())
    .filter(
      (line) =>
        !line.includes('line above') &&
        !line.includes('lines above') &&
        !line.includes('line below') &&
        !line.includes('lines below') &&
        !line.includes('new event'),
    );
}

function contentRows(frame: string): string[] {
  return normalizedRows(frame).filter((line) => /^line-\d+$/.test(line));
}

function renderConversation(events: EngineEvent[], height: number, conversationWidth: number) {
  eventsStore.__testReset({ events });
  return renderFeature(
    <ConversationFlow
      height={height}
      conversationWidth={conversationWidth}
      contentWidth={conversationWidth}
    />,
  );
}

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

describe('ConversationFlow', () => {
  beforeEach(() => {
    eventsStore.__testReset();
    conversationScrollStore.reset();
    streamingOutputStore.__testReset();
    lifecycleStore.__testReset();
    tasksStore.__testReset();
  });

  it('renders markdown planner documents without raw markdown control markers', () => {
    const ui = renderConversation([makeMarkdownPlannerText()], 20, 90);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('Description');
    expect(frame).toContain('Signature');
    expect(frame).toContain('// No exported signature.');
    expect(frame).not.toMatch(/[│┆]/);
    expect(frame).not.toMatch(/─{3,}/);
    expect(frame).not.toContain('###');
    expect(frame).not.toContain('```typescript');
    expect(frame).not.toContain('```');

    ui.unmount();
  });

  it('styles live researching Task Brief markdown through the workflow event path', async () => {
    const ui = renderFeature(
      <ConversationFlow height={20} conversationWidth={90} contentWidth={90} />,
    );

    addEvent(makeLiveTaskBriefPlannerText());
    await tick();
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('Description');
    expect(frame).toContain('Signature');
    expect(frame).toContain('Validation');
    expect(frame).toContain('export function renderLiveBrief(): void');
    expect(frame).toContain('scripts:');
    expect(frame).toContain('typecheck: npm run typecheck');
    expect(frame).not.toContain('###');
    expect(frame).not.toContain('```ts');
    expect(frame).not.toContain('```yaml');
    expect(frame).not.toContain('```');
    expect(frame).not.toContain('---');

    ui.unmount();
  });

  it('renders safe runner activity as a styled conversation row', () => {
    const ui = renderConversation([makeRunnerActivity()], 5, 90);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain("RUN   sed -n '1,260p' CLAUDE.md");
    expect(frame).not.toContain('/bin/zsh -lc');
    expect(frame).not.toContain('activity:');

    ui.unmount();
  });

  it('keeps scroll indicators inside the fixed viewport', () => {
    const events = Array.from({ length: 6 }, (_, index) => makePlannerText(index));

    conversationScrollStore.__testReset({
      scrollOffset: 1,
      renderableCountAtScroll: events.length,
      heightAtScroll: 11,
    });

    const ui = renderConversation(events, 10, 80);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('1 line below');
    expect(frameRowCount(frame)).toBeLessThanOrEqual(10);

    ui.unmount();
  });

  it('keeps the below scroll banner rule within the conversation width', () => {
    const events = Array.from({ length: 6 }, (_, index) => makePlannerText(index));
    const conversationWidth = 60;

    eventsStore.__testReset({ events });
    conversationScrollStore.__testReset({
      scrollOffset: 1,
      renderableCountAtScroll: events.length,
      heightAtScroll: 11,
    });

    const ui = renderFeature(
      <ConversationFlow
        height={10}
        conversationWidth={conversationWidth}
        contentWidth={conversationWidth}
      />,
    );
    const frame = ui.lastFrame() ?? '';
    const bannerLine =
      stripAnsiStyles(frame)
        .split('\n')
        .find((line) => line.includes('line below')) ?? '';

    expect(frame).toContain('1 line below');
    expect(bannerLine.length).toBeLessThanOrEqual(conversationWidth);
    expect(bannerLine.indexOf('line below')).toBeLessThan(conversationWidth);

    ui.unmount();
  });

  it('shows new renderable events without growing the viewport when scrolled up', () => {
    const events = Array.from({ length: 7 }, (_, index) => makePlannerText(index));

    conversationScrollStore.__testReset({
      scrollOffset: 1,
      renderableCountAtScroll: 6,
      heightAtScroll: 11,
    });

    const ui = renderConversation(events, 10, 80);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('↓ 1 new event');
    expect(frame).toContain('3 lines below');
    expect(frameRowCount(frame)).toBeLessThanOrEqual(10);

    ui.unmount();
  });

  it('moves a tall event by one rendered row between adjacent scroll offsets', () => {
    const events: EngineEvent[] = [makePlannerTextBlock(12)];

    conversationScrollStore.__testReset({
      scrollOffset: 0,
      renderableCountAtScroll: 1,
      heightAtScroll: 12,
    });
    const bottom = renderConversation(events, 6, 80);
    const bottomFrame = bottom.lastFrame() ?? '';
    bottom.unmount();

    conversationScrollStore.__testReset({
      scrollOffset: 1,
      renderableCountAtScroll: 1,
      heightAtScroll: 12,
    });
    const scrolled = renderConversation(events, 6, 80);
    const scrolledFrame = scrolled.lastFrame() ?? '';

    expect(contentRows(bottomFrame)).toEqual(['line-8', 'line-9', 'line-10', 'line-11', 'line-12']);
    expect(contentRows(scrolledFrame)).toEqual([
      'line-7',
      'line-8',
      'line-9',
      'line-10',
      'line-11',
    ]);
    expect(scrolledFrame).toContain('1 line below');
    expect(frameRowCount(scrolledFrame)).toBeLessThanOrEqual(6);

    scrolled.unmount();
  });

  it('scrolls a wrapped task_started card by rendered rows, not by the whole card', () => {
    const events: EngineEvent[] = [makeLongTaskStarted(), makePlannerTextBlock(8)];

    conversationScrollStore.__testReset({
      scrollOffset: 4,
      renderableCountAtScroll: 2,
      heightAtScroll: 13,
    });
    const bottom = renderConversation(events, 7, 72);
    const bottomRows = windowRows(bottom.lastFrame() ?? '');
    bottom.unmount();

    conversationScrollStore.__testReset({
      scrollOffset: 5,
      renderableCountAtScroll: 2,
      heightAtScroll: 13,
    });
    const scrolled = renderConversation(events, 7, 72);
    const scrolledFrame = scrolled.lastFrame() ?? '';
    const scrolledRows = windowRows(scrolledFrame);

    expect(scrolledRows.slice(1)).toEqual(bottomRows.slice(0, -1));
    expect(scrolledFrame).toContain('5 lines below');
    expect(frameRowCount(scrolledFrame)).toBeLessThanOrEqual(7);

    scrolled.unmount();
  });

  it('includes streaming output in row height and scrolls it one rendered row at a time', () => {
    const events: EngineEvent[] = [makeRunningImplementer()];
    streamingOutputStore.__testReset({
      active: true,
      taskId: taskId('T001'),
      lines: ['stream-1', 'stream-2', 'stream-3', 'stream-4', 'stream-5', 'stream-6'],
    });

    conversationScrollStore.__testReset({
      scrollOffset: 0,
      renderableCountAtScroll: 1,
      heightAtScroll: 6,
    });
    const bottom = renderConversation(events, 5, 80);
    const bottomRows = normalizedRows(bottom.lastFrame() ?? '');
    bottom.unmount();

    conversationScrollStore.__testReset({
      scrollOffset: 1,
      renderableCountAtScroll: 1,
      heightAtScroll: 6,
    });
    const scrolled = renderConversation(events, 5, 80);
    const scrolledFrame = scrolled.lastFrame() ?? '';
    const scrolledRows = normalizedRows(scrolledFrame);

    expect(bottomRows).toEqual(['stream-2', 'stream-3', 'stream-4', 'stream-5']);
    expect(scrolledRows).toEqual(['stream-1', 'stream-2', 'stream-3', 'stream-4']);
    expect(scrolledFrame).not.toMatch(/[│┆]/);
    expect(scrolledFrame).toContain('1 line below');
    expect(frameRowCount(scrolledFrame)).toBeLessThanOrEqual(5);

    scrolled.unmount();
  });

  it('does not let completed task summaries expand the fixed viewport', () => {
    const events: EngineEvent[] = [
      { ...makeLongTaskStarted(), title: 'Finished task' },
      makeTaskCompleted(),
      ...Array.from({ length: 6 }, (_, index) => makePlannerText(index)),
    ];

    conversationScrollStore.__testReset({
      scrollOffset: 1,
      renderableCountAtScroll: 6,
      heightAtScroll: 11,
    });

    const ui = renderConversation(events, 10, 80);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('Finished task');
    expect(frame).toContain('◇ completed');
    expect(frame).toMatch(/event \d/);
    expect(frameRowCount(frame)).toBeLessThanOrEqual(10);

    ui.unmount();
  });

  it('pins one ◇ completed section pip above the sticky summary block', () => {
    const events: EngineEvent[] = [
      { ...makeLongTaskStarted(), title: 'Finished task' },
      makeTaskCompleted(),
    ];

    const ui = renderConversation(events, 8, 80);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('◇ completed');
    expect(frame).toContain('Finished task');
    expect(frame.match(/◇/g) ?? []).toHaveLength(1);

    ui.unmount();
  });

  it('renders pending tasks as queued ○ rows below the live transcript', () => {
    const events = makeActivityReads(['src/a.ts']);
    tasksStore.__testReset({
      tasks: [{ id: taskId('T002'), title: 'wire login route', status: 'pending' }],
    });

    const ui = renderConversation(events, 12, 90);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain(QUEUED_MARK);
    expect(frame).toContain('wire login route');

    ui.unmount();
  });

  it('lifts the above scroll label to the chrome divider via onScrollAbove', async () => {
    const events = Array.from({ length: 6 }, (_, index) => makePlannerText(index));
    const calls: string[] = [];

    eventsStore.__testReset({ events });
    conversationScrollStore.__testReset({
      scrollOffset: 1,
      renderableCountAtScroll: events.length,
      heightAtScroll: 11,
    });

    const ui = renderFeature(
      <ConversationFlow
        height={10}
        conversationWidth={80}
        contentWidth={80}
        onScrollAbove={(label) => {
          calls.push(label);
        }}
      />,
    );
    await tick();

    expect(calls.at(-1)).toBe('1 line above');
    expect(ui.lastFrame() ?? '').not.toContain('line above');

    ui.unmount();
  });

  it('renders task_full_fail as a completed failed task in the runtime flow', () => {
    const events: EngineEvent[] = [
      { ...makeLongTaskStarted(), title: 'Failed runtime task' },
      makeTaskFullFail(),
    ];

    const ui = renderConversation(events, 5, 80);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('Failed runtime task');
    expect(frame).toContain('failed');
    expect(frame).not.toContain('No events yet');

    ui.unmount();
  });

  it('renders a user message only in the conversation row surface', () => {
    const userText = 'unique user prompt should appear exactly once';
    const ui = renderFeature(
      <ConversationFlow height={8} conversationWidth={90} contentWidth={90} />,
    );
    eventsStore.__testReset({
      events: [
        {
          type: 'user_message',
          ts: 0,
          phase: 'implementing',
          text: userText,
        },
      ],
    });
    ui.rerender(<ConversationFlow height={8} conversationWidth={90} contentWidth={90} />);

    const frame = ui.lastFrame() ?? '';
    expect(frame.match(new RegExp(userText, 'g')) ?? []).toHaveLength(1);
    ui.unmount();
  });

  it('renders user messages without the heavy-angle prompt marker', () => {
    const ui = renderConversation(
      [{ type: 'user_message', ts: 0, phase: 'implementing', text: 'tighten the rail spacing' }],
      8,
      90,
    );
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('tighten the rail spacing');
    expect(frame).not.toContain('❯');

    ui.unmount();
  });

  it('does not blink a historical visible activity row when the latest active row is off-screen', async () => {
    const events: EngineEvent[] = [
      makeActivityReadForCall(1, 'old-call', 'src/old.ts'),
      makePlannerTextBlock(24),
      makeActivityReadForCall(2, 'latest-call', 'src/latest.ts'),
    ];

    conversationScrollStore.__testReset({
      scrollOffset: 24,
      renderableCountAtScroll: events.length,
      heightAtScroll: 28,
    });
    lifecycleStore.__testReset({ status: 'running', phase: 'researching' });
    const ui = renderConversation(events, 6, 90);
    const framesBefore = ui.frames.length;

    await tick(650);

    expect(ui.lastFrame() ?? '').toContain('src/old.ts');
    expect(ui.lastFrame() ?? '').not.toContain('src/latest.ts');
    expect(ui.frames).toHaveLength(framesBefore);
    ui.unmount();
  });

  it('shows the +N more disclosure with a ctrl+a hint and no tree connector', () => {
    const events = makeActivityReads(['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts']);
    const batchKey = 'activity-batch:0:call-1';

    conversationScrollStore.__testReset({ expandedActivityBatches: new Set() });
    const collapsed = renderConversation(events, 12, 90);
    const collapsedFrame = collapsed.lastFrame() ?? '';
    expect(collapsedFrame).toContain('more · ctrl+a');
    expect(collapsedFrame).not.toContain('▸');
    expect(collapsedFrame).not.toContain('▾');
    collapsed.unmount();

    conversationScrollStore.__testReset({
      expandedActivityBatches: new Set([batchKey]),
    });
    const expanded = renderConversation(events, 12, 90);
    const expandedFrame = expanded.lastFrame() ?? '';
    expect(expandedFrame).toContain('collapse · ctrl+a');
    expect(expandedFrame).not.toContain('▸');
    expect(expandedFrame).not.toContain('▾');
    expanded.unmount();
  });

  it('renders the activity dot on the live running row', () => {
    const events = makeActivityReads(['src/a.ts', 'src/b.ts']);
    const batchKey = 'activity-batch:0:call-1';

    conversationScrollStore.__testReset({ expandedActivityBatches: new Set([batchKey]) });
    lifecycleStore.__testReset({ status: 'running', phase: 'researching' });
    const running = renderConversation(events, 12, 90);
    const runningFrame = running.lastFrame() ?? '';
    expect(runningFrame).toContain(LIVE_MARK);
    expect(runningFrame).toContain('plan activity');
    expect(runningFrame).toContain('READ  src/a.ts');
    running.unmount();
  });

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

  it('prefixes the ▌ focus bar before the done ✓ on a focused completed header', () => {
    const row = makeTaskHeaderRow('task-header:T001');

    const ui = renderFeature(<ConversationRowView row={row} focused={true} />);
    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain(FOCUS_MARK);
    expect(frame).toContain(DONE_MARK);
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

describe('the four-tone palette resolves to exactly the rendered colors', () => {
  for (const mode of ['terminal', 'mono'] as const) {
    const theme = getTheme(mode);

    it(`maps every surviving tone onto its theme color in ${mode}`, () => {
      expect(colorForTone(undefined, theme)).toBe(theme.text);
      expect(colorForTone('text', theme)).toBe(theme.text);
      expect(colorForTone('textDim', theme)).toBe(theme.textDim);
      expect(colorForTone('success', theme)).toBe(theme.success);
      expect(colorForTone('error', theme)).toBe(theme.error);
    });

    it(`keeps dim metadata distinct from primary text and every state hue in ${mode}`, () => {
      expect(colorForTone('textDim', theme)).not.toBe(colorForTone('text', theme));
      for (const hue of [theme.accent, theme.success, theme.error, theme.planner]) {
        expect(colorForTone('textDim', theme)).not.toBe(hue);
      }
    });
  }
});

describe('color-off degradation contract', () => {
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

describe('conversation hover rendering', () => {
  beforeEach(() => {
    hoverStore.clear();
    projectionCache.resetConversationRowsProjectionCache();
  });

  it('does not rebuild conversation projection when only hover changes', async () => {
    eventsStore.__testReset({
      events: [makePlannerTextBlock(8)],
    });
    const projectionSpy = vi.spyOn(projectionCache, 'getConversationRowsProjection');
    const ui = renderConversation([makePlannerTextBlock(8)], 10, 90);
    const callsAfterMount = projectionSpy.mock.calls.length;
    expect(callsAfterMount).toBeGreaterThan(0);

    hoverStore.set('conversation', 2);
    await tick(20);

    expect(projectionSpy.mock.calls.length).toBe(callsAfterMount);
    ui.unmount();
    projectionSpy.mockRestore();
  });
});
