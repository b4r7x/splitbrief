import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderFeature, tick } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { makePlannerText as makePlannerTextEvent } from '#testing/helpers/events/planner.js';
import { makeRunnerCallActivity } from '#testing/helpers/events/runner-call.js';
import { makeTaskStart, makeTaskComplete } from '#testing/helpers/events/task.js';
import { makeImplementerGenerate } from '#testing/helpers/events/implementer.js';
import { conversationScrollStore } from '../../../../stores/workflow/conversation-scroll.js';
import { streamingOutputStore } from '../../../../stores/workflow/streaming-output.js';
import { eventsStore } from '../../../../stores/workflow/events.js';
import { lifecycleStore } from '../../../../stores/workflow/lifecycle.js';
import { tasksStore } from '../../../../stores/workflow/tasks.js';
import { addEvent } from '../../../../stores/workflow/actions/event.js';
import { taskId } from '../../../../core/schemas/task.js';
import { CREW_SEAT_LABELS } from '../../../../core/crew/identity.js';
import type { EngineEvent } from '../../../../engine/events/types.js';
import { glyph } from '../../../../lib/glyphs.js';
import { displayActivityLabel } from '../../display/activity-label-display.js';
import { ConversationFlow } from './flow.js';
import { hoverStore } from '../../../../stores/ui/hover.js';
import { controlsStore } from '../../../../stores/ui/controls.js';
import { terminalSizeStore } from '../../../../stores/ui/terminal-size.js';
import { configStore } from '../../../../stores/project/config.js';
import * as projectionCache from '../../conversation-rows/projection-cache.js';
import { resetMarkdownConversationRowsCache } from '../../conversation-rows/markdown-rows.js';

const QUEUED_MARK = glyph('statusPending');
const LIVE_MARK = glyph('statusInProgress');
const FOCUS_MARK = glyph('liveBar');
const COMPLETED_HEADER = 'Completed';

function expectActivityLine(
  frame: string,
  label: Parameters<typeof displayActivityLabel>[0],
  value: string,
): void {
  const line = frame.split('\n').find((candidate) => candidate.includes(value)) ?? '';
  expect(line).toContain(displayActivityLabel(label));
  expect(line).toContain(value);
}

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
  return makeRunnerCallActivity('planner-read', {
    sequence: 2,
    activityId: 'call-1:system',
    kind: 'unknown',
    label: '/bin/zsh -lc "sed -n \'1,260p\' CLAUDE.md"',
  });
}

function makeActivityRead(
  sequence: number,
  file: string,
): Extract<EngineEvent, { type: 'runner_call_activity' }> {
  return makeRunnerCallActivity('planner-read', {
    ts: sequence,
    sequence,
    activityId: `call-1:read:${file}`,
    stage: 'completed',
    label: `reading ${file}`,
  });
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

function makeReviewActivity(
  runnerName: string,
): Extract<EngineEvent, { type: 'runner_call_activity' }> {
  return makeRunnerCallActivity('planner-read', {
    phase: 'final-review',
    role: 'review',
    runnerName,
    label: 'reading review.md',
  });
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

function renderConversation(
  events: EngineEvent[],
  height: number,
  conversationWidth: number,
  onScrollBelow?: (label: string) => void,
) {
  eventsStore.__testReset({ events });
  return renderFeature(
    <ConversationFlow
      height={height}
      conversationWidth={conversationWidth}
      contentWidth={conversationWidth}
      {...(onScrollBelow ? { onScrollBelow } : {})}
    />,
  );
}

function countGlyphOccurrences(frame: string, mark: string): number {
  if (mark.length === 0) return 0;
  let count = 0;
  let index = frame.indexOf(mark);
  while (index !== -1) {
    count += 1;
    index = frame.indexOf(mark, index + mark.length);
  }
  return count;
}

describe('ConversationFlow', () => {
  beforeEach(() => {
    eventsStore.__testReset();
    conversationScrollStore.reset();
    streamingOutputStore.__testReset();
    lifecycleStore.__testReset();
    tasksStore.__testReset();
    controlsStore.__testReset();
    terminalSizeStore.__testReset({ cols: 90, rows: 30, isSmall: true });
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

    const activityHeader =
      frame
        .split('\n')
        .find((candidate) => candidate.includes(`${CREW_SEAT_LABELS.plan} activity`)) ?? '';
    expect(activityHeader).toContain('1 update');
    expect(activityHeader).toContain('OpenAI Codex CLI');
    expectActivityLine(frame, 'READ', 'CLAUDE.md :1-260');
    expect(frame).not.toContain('/bin/zsh -lc');
    expect(frame).not.toContain('activity:');

    ui.unmount();
  });

  it('reports the seat that ran the final review, not a borrowed planner identity', () => {
    const reviewer = renderConversation([makeReviewActivity('codex')], 5, 90);
    expect(reviewer.lastFrame() ?? '').toContain('OpenAI Codex CLI');
    reviewer.unmount();

    const planner = renderConversation([makeReviewActivity('claude-code')], 5, 90);
    expect(planner.lastFrame() ?? '').toContain('Claude Code CLI');
    planner.unmount();
  });

  it('lifts the below scroll label to the chrome divider and keeps the viewport fixed', () => {
    const events = Array.from({ length: 6 }, (_, index) => makePlannerText(index));
    const belowCalls: string[] = [];

    conversationScrollStore.__testReset({
      scrollOffset: 1,
      renderableCountAtScroll: events.length,
      heightAtScroll: 11,
    });

    const ui = renderConversation(events, 10, 80, (label) => belowCalls.push(label));
    const frame = ui.lastFrame() ?? '';

    expect(belowCalls.at(-1)).toBe('1 line below');
    expect(frame).not.toContain('line below');
    expect(frameRowCount(frame)).toBeLessThanOrEqual(10);

    ui.unmount();
  });

  it('combines lines below and new events into one chrome label', () => {
    const events = Array.from({ length: 7 }, (_, index) => makePlannerText(index));
    const belowCalls: string[] = [];

    conversationScrollStore.__testReset({
      scrollOffset: 1,
      renderableCountAtScroll: 6,
      heightAtScroll: 11,
    });

    const ui = renderConversation(events, 10, 80, (label) => belowCalls.push(label));
    const frame = ui.lastFrame() ?? '';

    expect(belowCalls.at(-1)).toBe('3 lines below · ↓ 1 new event');
    expect(frame).not.toContain('new event');
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

    const belowCalls: string[] = [];
    conversationScrollStore.__testReset({
      scrollOffset: 1,
      renderableCountAtScroll: 1,
      heightAtScroll: 12,
    });
    const scrolled = renderConversation(events, 6, 80, (label) => belowCalls.push(label));
    const scrolledFrame = scrolled.lastFrame() ?? '';

    expect(contentRows(bottomFrame)).toEqual([
      'line-7',
      'line-8',
      'line-9',
      'line-10',
      'line-11',
      'line-12',
    ]);
    expect(contentRows(scrolledFrame)).toEqual([
      'line-6',
      'line-7',
      'line-8',
      'line-9',
      'line-10',
      'line-11',
    ]);
    expect(belowCalls.at(-1)).toBe('1 line below');
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

    const belowCalls: string[] = [];
    conversationScrollStore.__testReset({
      scrollOffset: 5,
      renderableCountAtScroll: 2,
      heightAtScroll: 13,
    });
    const scrolled = renderConversation(events, 7, 72, (label) => belowCalls.push(label));
    const scrolledFrame = scrolled.lastFrame() ?? '';
    const scrolledRows = windowRows(scrolledFrame);

    expect(scrolledRows.slice(1)).toEqual(bottomRows.slice(0, -1));
    expect(belowCalls.at(-1)).toBe('5 lines below');
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

    const belowCalls: string[] = [];
    conversationScrollStore.__testReset({
      scrollOffset: 1,
      renderableCountAtScroll: 1,
      heightAtScroll: 6,
    });
    const scrolled = renderConversation(events, 5, 80, (label) => belowCalls.push(label));
    const scrolledFrame = scrolled.lastFrame() ?? '';
    const scrolledRows = normalizedRows(scrolledFrame);

    expect(bottomRows).toEqual(['stream-1', 'stream-2', 'stream-3', 'stream-4', 'stream-5']);
    expect(scrolledRows).toEqual([
      'generating README.md...',
      'stream-1',
      'stream-2',
      'stream-3',
      'stream-4',
    ]);
    expect(scrolledFrame).not.toMatch(/[│┆]/);
    expect(belowCalls.at(-1)).toBe('1 line below');
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
    expect(frame).toContain(COMPLETED_HEADER);
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

    expect(frame).toContain(COMPLETED_HEADER);
    expect(frame).toContain('Finished task');
    expect(frame.match(new RegExp(COMPLETED_HEADER, 'g')) ?? []).toHaveLength(1);

    ui.unmount();
  });

  it('renders pending tasks as queued ○ rows below the live transcript', () => {
    const events = makeActivityReads(['src/a.ts']);
    tasksStore.__testReset({
      tasks: [{ id: taskId('T002'), title: 'wire login route', status: 'pending' }],
    });
    terminalSizeStore.__testReset({ cols: 90, rows: 30, isSmall: true });

    const ui = renderConversation(events, 12, 90);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain(QUEUED_MARK);
    expect(frame).toContain('wire login route');

    ui.unmount();
  });

  it('keeps the queued block while the sidebar is suppressed below its column breakpoint', () => {
    const events = makeActivityReads(['src/a.ts']);
    tasksStore.__testReset({
      tasks: [{ id: taskId('T002'), title: 'wire login route', status: 'pending' }],
    });
    controlsStore.setSidebar(true);
    terminalSizeStore.__testReset({ cols: 100, rows: 30, isSmall: true });

    const ui = renderConversation(events, 12, 90);

    expect(ui.lastFrame() ?? '').toContain('wire login route');

    ui.unmount();
  });

  it('stands the queued block down while the sidebar renders the same pending list', () => {
    const events = makeActivityReads(['src/a.ts']);
    tasksStore.__testReset({
      tasks: [{ id: taskId('T002'), title: 'wire login route', status: 'pending' }],
    });
    controlsStore.setSidebar(true);
    terminalSizeStore.__testReset({ cols: 160, rows: 30, isSmall: false });

    const ui = renderConversation(events, 12, 120);
    const frame = ui.lastFrame() ?? '';

    expect(frame).not.toContain('wire login route');
    expect(frame).toContain('src/a.ts');

    ui.unmount();
  });

  it('gives the transcript the rows the queued block no longer reserves', () => {
    const events = Array.from({ length: 12 }, (_, index) => makePlannerText(index));
    tasksStore.__testReset({
      tasks: [
        { id: taskId('T002'), title: 'wire login route', status: 'pending' },
        { id: taskId('T003'), title: 'wire logout route', status: 'pending' },
      ],
    });
    controlsStore.setSidebar(true);

    const transcriptRows = (frame: string): number =>
      normalizedRows(frame).filter((line) => /^event \d+$/.test(line)).length;

    terminalSizeStore.__testReset({ cols: 100, rows: 30, isSmall: true });
    const narrow = renderConversation(events, 12, 90);
    const narrowRows = transcriptRows(narrow.lastFrame() ?? '');
    narrow.unmount();

    terminalSizeStore.__testReset({ cols: 160, rows: 30, isSmall: false });
    const wide = renderConversation(events, 12, 90);
    const wideRows = transcriptRows(wide.lastFrame() ?? '');
    wide.unmount();

    expect(wideRows).toBeGreaterThan(narrowRows);
  });

  it('lifts the above scroll label to the chrome divider via onScrollAbove', async () => {
    const events = Array.from({ length: 6 }, (_, index) => makePlannerText(index));
    const calls: string[] = [];

    eventsStore.__testReset({ events });
    conversationScrollStore.__testReset({
      scrollOffset: 0,
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
    expect(runningFrame).toContain(`${CREW_SEAT_LABELS.plan} activity`);
    expectActivityLine(runningFrame, 'READ', 'src/a.ts');
    running.unmount();
  });

  it('keeps the live status out of the transcript while a stage runs', () => {
    const events = makeActivityReads(['src/a.ts', 'src/b.ts']);
    lifecycleStore.__testReset({
      status: 'running',
      phase: 'researching',
      startedAt: Date.now() - 5_000,
    });
    const ui = renderConversation(events, 12, 90);
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    expect(frame).toContain(`${CREW_SEAT_LABELS.plan} activity`);
    expect(frame).not.toContain('Researching…');
    ui.unmount();
  });

  it('keeps the live header on a single-event activity group instead of a lone item row', () => {
    const events = makeActivityReads(['src/only.ts']);
    lifecycleStore.__testReset({ status: 'running', phase: 'researching', startedAt: 0 });
    const ui = renderConversation(events, 12, 90);
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    expect(frame).toContain(`${CREW_SEAT_LABELS.plan} activity`);
    expect(frame).toContain('src/only.ts');
    ui.unmount();
  });

  it('shows exactly one focus glyph on hover and restores the baseline when cleared', async () => {
    const events = [makePlannerTextBlock(8)];
    hoverStore.clear();
    const ui = renderConversation(events, 10, 90);
    const baseline = stripAnsiStyles(ui.lastFrame() ?? '');
    expect(baseline).not.toContain(FOCUS_MARK);

    hoverStore.set('conversation', 2);
    await tick(20);
    const focused = stripAnsiStyles(ui.lastFrame() ?? '');
    expect(countGlyphOccurrences(focused, FOCUS_MARK)).toBe(1);
    for (let line = 1; line <= 8; line += 1) {
      expect(focused).toContain(`line-${line}`);
      expect(baseline).toContain(`line-${line}`);
    }

    hoverStore.clear();
    await tick(20);
    expect(stripAnsiStyles(ui.lastFrame() ?? '')).toBe(baseline);
    ui.unmount();
  });
});

describe('transcript OSC 8 hyperlinks', () => {
  const originalForceHyperlink = process.env['FORCE_HYPERLINK'];

  function makeFileLinkPlannerText(): Extract<EngineEvent, { type: 'planner_text' }> {
    return makePlannerTextEvent({
      ts: 0,
      phase: 'planning',
      content: 'markdown',
      text: '[src/app/root.tsx:14](src/app/root.tsx:14)',
    });
  }

  beforeEach(() => {
    configStore.__testReset({ projectDir: '/repo' });
    projectionCache.resetConversationRowsProjectionCache();
    resetMarkdownConversationRowsCache();
  });

  afterEach(() => {
    if (originalForceHyperlink === undefined) {
      delete process.env['FORCE_HYPERLINK'];
    } else {
      process.env['FORCE_HYPERLINK'] = originalForceHyperlink;
    }
    configStore.__testReset();
  });

  it('wraps transcript file links in OSC 8 when forced on', () => {
    process.env['FORCE_HYPERLINK'] = '1';
    const ui = renderConversation([makeFileLinkPlannerText()], 20, 90);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('\x1b]8;;file://');
    ui.unmount();
  });

  it('emits no OSC 8 bytes when hyperlinks are forced off', () => {
    process.env['FORCE_HYPERLINK'] = '0';
    const ui = renderConversation([makeFileLinkPlannerText()], 20, 90);
    const frame = ui.lastFrame() ?? '';

    expect(frame).not.toContain('\x1b]8');
    expect(frame).toContain('src/app/root.tsx:14');
    ui.unmount();
  });
});
