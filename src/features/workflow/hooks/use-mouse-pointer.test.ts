import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeRunRecord } from '#testing/helpers/factories/run-record.js';
import {
  _resetHoverThrottle,
  handleWorkflowMouseMove,
  handleWorkflowMousePress,
} from './use-mouse-pointer.js';
import type { MouseEvent } from '../../../lib/terminal/filtered-stdin/types.js';
import { routerStore } from '../../../stores/navigation/router.js';
import { overlayStore } from '../../../stores/ui/overlay.js';
import { controlsStore } from '../../../stores/ui/controls.js';
import { reviewStore } from '../../../stores/workflow/review.js';
import { hoverStore } from '../../../stores/ui/hover.js';
import { completionStore } from '../../../stores/ui/completion.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { conversationScrollStore } from '../../../stores/workflow/conversation-scroll.js';
import { eventsStore } from '../../../stores/workflow/events.js';
import { lifecycleStore } from '../../../stores/workflow/lifecycle.js';
import { resetWorkflow } from '../../../stores/workflow/actions/reset.js';
import { inputHeightStore } from '../../../stores/ui/input-height.js';
import { _resetMouseZones, registerMouseZone } from '../../../lib/terminal/mouse-zones.js';
import { readConversationScrollSnapshot, readRailSnapshot } from '../layout/snapshot.js';
import { computeConversationRowScroll } from '../conversation-rows/scroll.js';
import { activityBatchKey } from '../conversation-rows/activity-batch-key.js';
import { rowText } from '../conversation-rows/row-format/rows.js';
import { getSections } from '../../../stores/workflow/actions/sections.js';
import { streamingOutputStore } from '../../../stores/workflow/streaming-output.js';
import type { EngineEventOf } from '../../../engine/events/types.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makePreparedExecution } from '#testing/helpers/factories/prepared-execution.js';
import { makeImplementerGenerate } from '#testing/helpers/events/implementer.js';
import { makePlannerText } from '#testing/helpers/events/planner.js';

const WORKFLOW_ROUTE = {
  screen: 'workflow',
  run: makeRunRecord(),
  execution: {
    kind: 'local',
    prepared: makePreparedExecution({
      projectDir: '/tmp/mouse-pointer-test',
      sessionId: 'mouse-pointer-session',
      feature: 'feat',
      config: makeConfig(),
      gates: () => [],
    }),
  },
} as const;

function seedTallTranscript(): void {
  eventsStore.__testReset({
    events: [
      makePlannerText({ text: Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n') }),
    ],
  });
}

function activityEvent(
  activityId: string,
  label: string,
  sequence: number,
): EngineEventOf<'runner_call_activity'> {
  return {
    type: 'runner_call_activity',
    ts: 0,
    phase: 'researching',
    callId: 'call-1',
    role: 'planner',
    backendKind: 'cli',
    runnerName: 'codex',
    sequence,
    activityId,
    stage: 'updated',
    kind: 'read',
    label,
    redacted: false,
  };
}

function seedActivityBatch(): string {
  eventsStore.__testReset({
    events: [
      activityEvent('a', 'reading a.ts', 1),
      activityEvent('b', 'reading b.ts', 2),
      activityEvent('c', 'reading c.ts', 3),
      activityEvent('d', 'reading d.ts', 4),
    ],
  });
  return activityBatchKey(0, 'call-1');
}

function seedDiff(): void {
  eventsStore.__testReset({
    events: [makeImplementerGenerate({ status: 'done', diff: '+ changed' })],
  });
}

function seedLiveDisclosureTranscript(): void {
  eventsStore.__testReset({
    events: [
      makePlannerText({ text: Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n') }),
      activityEvent('a', 'reading a.ts', 1),
      activityEvent('b', 'reading b.ts', 2),
      activityEvent('c', 'reading c.ts', 3),
      activityEvent('d', 'reading d.ts', 4),
      makePlannerText({ text: 'wrapping up' }),
    ],
  });
}

function transcriptViewportRows() {
  const snapshot = readConversationScrollSnapshot();
  const scroll = conversationScrollStore.get();
  return computeConversationRowScroll({
    sections: getSections(),
    expandedDiffs: scroll.expandedDiffs,
    expandedActivityBatches: scroll.expandedActivityBatches,
    cols: snapshot.conversationWidth,
    viewportHeight: snapshot.transcriptViewportHeight,
    rawScrollOffset: scroll.scrollOffset,
    renderableCountAtScroll: scroll.renderableCountAtScroll,
    heightAtScroll: scroll.heightAtScroll,
    streaming: streamingOutputStore.get(),
  }).rows;
}

function transcriptRows() {
  const snapshot = readConversationScrollSnapshot();
  const scroll = conversationScrollStore.get();
  return computeConversationRowScroll({
    sections: getSections(),
    expandedDiffs: scroll.expandedDiffs,
    expandedActivityBatches: scroll.expandedActivityBatches,
    cols: snapshot.conversationWidth,
    viewportHeight: snapshot.contentRect.height,
    rawScrollOffset: scroll.scrollOffset,
    renderableCountAtScroll: scroll.renderableCountAtScroll,
    heightAtScroll: scroll.heightAtScroll,
    streaming: streamingOutputStore.get(),
  }).rows;
}

function dispatchWorkflowPointer(event: MouseEvent): void {
  if (event.type === 'move') {
    handleWorkflowMouseMove(event);
    return;
  }
  if (event.type === 'press') handleWorkflowMousePress(event);
}

function pointerEvent(type: MouseEvent['type'], x: number, y: number): MouseEvent {
  const button = type === 'wheel-up' ? 64 : type === 'wheel-down' ? 65 : type === 'move' ? 3 : 0;
  return { type, x, y, button, shift: false, meta: false, ctrl: false };
}

describe('workflow pointer handling', () => {
  beforeEach(() => {
    routerStore.reset();
    overlayStore.reset();
    controlsStore.reset();
    reviewStore.reset();
    hoverStore.clear();
    completionStore.reset();
    terminalSizeStore.__testReset({ rows: 30, cols: 80 });
    conversationScrollStore.reset();
    resetWorkflow();
    inputHeightStore.reset();
    lifecycleStore.__testReset();
    _resetMouseZones();
    _resetHoverThrottle();
  });

  it('ignores a click outside any zone or row', () => {
    routerStore.init(WORKFLOW_ROUTE);
    controlsStore.setInputMode('review');
    reviewStore.setReviewFile('plan.md', 12);
    dispatchWorkflowPointer(pointerEvent('press', 1, 1));

    expect(reviewStore.get().scrollOffset).toBe(0);
  });

  it('ignores wheel events (the scroll handler owns them)', () => {
    routerStore.init(WORKFLOW_ROUTE);
    controlsStore.setInputMode('review');
    reviewStore.setReviewFile('plan.md', 12);
    dispatchWorkflowPointer(pointerEvent('wheel-up', 5, 10));
    dispatchWorkflowPointer(pointerEvent('wheel-down', 5, 10));

    expect(reviewStore.get().scrollOffset).toBe(0);
  });

  it('runs the click action of a registered footer zone', () => {
    routerStore.init(WORKFLOW_ROUTE);
    registerMouseZone({
      id: 'footer',
      left: 60,
      right: 70,
      top: 28,
      bottom: 28,
      z: 10,
      onClick: () => overlayStore.open('help'),
    });
    dispatchWorkflowPointer(pointerEvent('press', 65, 28));

    expect(overlayStore.get().active).toBe('help');
  });

  it('blocks hover, transcript actions, and row zones behind an open completion menu', () => {
    routerStore.init(WORKFLOW_ROUTE);
    lifecycleStore.__testReset({ phase: 'implementing', status: 'running', startedAt: 0 });
    seedDiff();
    const snapshot = readConversationScrollSnapshot();
    const windowIndex = transcriptRows().findIndex((row) => rowText(row).includes('ctrl+d'));
    expect(windowIndex).toBeGreaterThanOrEqual(0);
    const x = snapshot.contentRect.left;
    const y = snapshot.contentRect.top + windowIndex;
    const onClick = vi.fn();
    registerMouseZone({ id: 'covered', left: x, right: x, top: y, bottom: y, z: 5, onClick });
    hoverStore.set(windowIndex);
    completionStore.setOpen(true);

    dispatchWorkflowPointer(pointerEvent('move', x, y));
    dispatchWorkflowPointer(pointerEvent('press', x, y));

    expect(hoverStore.get()).toBeNull();
    expect(conversationScrollStore.get().expandedDiffs.size).toBe(0);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('ignores a release event so X10 button-3 releases do not click a zone', () => {
    routerStore.init(WORKFLOW_ROUTE);
    const onClick = vi.fn();
    registerMouseZone({ id: 'z', left: 1, right: 80, top: 5, bottom: 5, z: 5, onClick });
    dispatchWorkflowPointer(pointerEvent('release', 10, 5));

    expect(onClick).not.toHaveBeenCalled();
  });

  it('click on the active rail stage scrolls the transcript to the bottom without setting focus', () => {
    routerStore.init(WORKFLOW_ROUTE);
    lifecycleStore.__testReset({ phase: 'implementing', status: 'running', startedAt: 0 });
    seedTallTranscript();
    const snapshot = readConversationScrollSnapshot();
    conversationScrollStore.__testReset({
      scrollOffset: 5,
      renderableCountAtScroll: 1,
      heightAtScroll: 9,
    });
    const buildZone = readRailSnapshot().zones.find((zone) => zone.index === 1);
    if (!buildZone) throw new Error('expected a build rail zone');
    dispatchWorkflowPointer(pointerEvent('press', buildZone.left, buildZone.top));

    const scroll = conversationScrollStore.get();
    expect(scroll.scrollOffset).toBe(0);
    expect(scroll.renderableCountAtScroll).toBe(snapshot.renderableCount);
  });

  it('routes distinct rail stages to distinct transcript scroll destinations', () => {
    routerStore.init(WORKFLOW_ROUTE);
    terminalSizeStore.__testReset({ cols: 120, rows: 40 });
    lifecycleStore.__testReset({ phase: 'final-review', status: 'running', startedAt: 0 });
    seedTallTranscript();
    const maxOffset = readConversationScrollSnapshot().maxOffset;
    expect(maxOffset).toBeGreaterThanOrEqual(2);
    const zones = readRailSnapshot().zones;
    const zoneFor = (index: number) => {
      const zone = zones.find((z) => z.index === index);
      if (!zone) throw new Error(`expected a rail zone for stage ${index}`);
      return zone;
    };

    const clickStage = (index: number): number => {
      conversationScrollStore.reset();
      const zone = zoneFor(index);
      dispatchWorkflowPointer(pointerEvent('press', zone.left, zone.top));
      return conversationScrollStore.get().scrollOffset;
    };

    // final-review → active stage is `review` (index 2): the earliest stage anchors to the top
    // (maxOffset), an in-between stage lands proportionally, and the active stage sits at the bottom.
    const plan = clickStage(0);
    const build = clickStage(1);
    const review = clickStage(2);

    expect(plan).toBe(maxOffset);
    expect(build).toBe(Math.round(maxOffset / 2));
    expect(review).toBe(0);
    expect(new Set([plan, build, review]).size).toBe(3);
  });

  it('clears hover on a move over the click-only rail', () => {
    routerStore.init(WORKFLOW_ROUTE);
    lifecycleStore.__testReset({ phase: 'implementing', status: 'running', startedAt: 0 });
    const railZone = readRailSnapshot().zones[0];
    if (!railZone) throw new Error('expected a rail zone');
    hoverStore.set(5);
    dispatchWorkflowPointer(pointerEvent('move', railZone.left, railZone.top));

    expect(hoverStore.get()).toBeNull();
  });

  it('clears hover on a move over empty space', () => {
    routerStore.init(WORKFLOW_ROUTE);
    lifecycleStore.__testReset({ phase: 'implementing', status: 'running', startedAt: 0 });
    hoverStore.set(3);
    dispatchWorkflowPointer(pointerEvent('move', 1, 1));

    expect(hoverStore.get()).toBeNull();
  });

  it('sets a conversation hover on a move over the transcript', () => {
    routerStore.init(WORKFLOW_ROUTE);
    lifecycleStore.__testReset({ phase: 'implementing', status: 'running', startedAt: 0 });
    const snapshot = readConversationScrollSnapshot();
    dispatchWorkflowPointer(
      pointerEvent('move', snapshot.contentRect.left, snapshot.contentRect.top),
    );

    expect(hoverStore.get()).toBe(0);
  });

  it('clears stale transcript hover and blocks transcript actions when review owns the body without a file', () => {
    routerStore.init(WORKFLOW_ROUTE);
    lifecycleStore.__testReset({ phase: 'implementing', status: 'running', startedAt: 0 });
    seedDiff();
    const snapshot = readConversationScrollSnapshot();
    const windowIndex = transcriptRows().findIndex((row) => rowText(row).includes('ctrl+d'));
    expect(windowIndex).toBeGreaterThanOrEqual(0);
    const x = snapshot.contentRect.left;
    const y = snapshot.contentRect.top + windowIndex;
    hoverStore.set(windowIndex);

    controlsStore.setInputMode('review');
    expect(reviewStore.get().filePath).toBeNull();
    dispatchWorkflowPointer(pointerEvent('move', x, y));
    dispatchWorkflowPointer(pointerEvent('press', x, y));

    expect(hoverStore.get()).toBeNull();
    expect(conversationScrollStore.get().expandedDiffs.size).toBe(0);
  });

  it('routes hover and press to the visible transcript in normal mode despite stale brief review state', () => {
    routerStore.init(WORKFLOW_ROUTE);
    lifecycleStore.__testReset({ phase: 'reviewing-briefs', status: 'running', startedAt: 0 });
    reviewStore.setReviewFile('briefs.md', 12);
    controlsStore.setInputMode('normal');
    seedDiff();
    const snapshot = readConversationScrollSnapshot();
    const windowIndex = transcriptRows().findIndex((row) => rowText(row).includes('ctrl+d'));
    expect(windowIndex).toBeGreaterThanOrEqual(0);
    const x = snapshot.contentRect.left;
    const y = snapshot.contentRect.top + windowIndex;

    dispatchWorkflowPointer(pointerEvent('move', x, y));
    dispatchWorkflowPointer(pointerEvent('press', x, y));

    expect(hoverStore.get()).toBe(windowIndex);
    expect(conversationScrollStore.get().expandedDiffs.has('implementer_generate_done:0')).toBe(
      true,
    );
  });

  it('clears hover on an invalid move even inside the throttle window', () => {
    routerStore.init(WORKFLOW_ROUTE);
    lifecycleStore.__testReset({ phase: 'implementing', status: 'running', startedAt: 0 });
    const snapshot = readConversationScrollSnapshot();
    const { left, top } = snapshot.contentRect;
    dispatchWorkflowPointer(pointerEvent('move', left, top));
    expect(hoverStore.get()).toBe(0);

    dispatchWorkflowPointer(pointerEvent('move', left, top - 1));
    expect(hoverStore.get()).toBeNull();
  });

  it('click on a +N more activity row expands the batch', () => {
    routerStore.init(WORKFLOW_ROUTE);
    lifecycleStore.__testReset({ phase: 'implementing', status: 'running', startedAt: 0 });
    const batchKey = seedActivityBatch();
    const snapshot = readConversationScrollSnapshot();
    const windowIndex = transcriptRows().findIndex((row) => row.kind === 'activity-more');
    expect(windowIndex).toBeGreaterThanOrEqual(0);
    expect(conversationScrollStore.get().expandedActivityBatches.has(batchKey)).toBe(false);

    dispatchWorkflowPointer(
      pointerEvent('press', snapshot.contentRect.left, snapshot.contentRect.top + windowIndex),
    );

    expect(conversationScrollStore.get().expandedActivityBatches.has(batchKey)).toBe(true);
  });

  it('click on the collapse activity row collapses the expanded batch', () => {
    routerStore.init(WORKFLOW_ROUTE);
    lifecycleStore.__testReset({ phase: 'implementing', status: 'running', startedAt: 0 });
    const batchKey = seedActivityBatch();
    conversationScrollStore.toggleActivityBatch(batchKey);
    expect(conversationScrollStore.get().expandedActivityBatches.has(batchKey)).toBe(true);

    const snapshot = readConversationScrollSnapshot();
    const windowIndex = transcriptRows().findIndex((row) => row.kind === 'activity-more');
    expect(windowIndex).toBeGreaterThanOrEqual(0);

    dispatchWorkflowPointer(
      pointerEvent('press', snapshot.contentRect.left, snapshot.contentRect.top + windowIndex),
    );

    expect(conversationScrollStore.get().expandedActivityBatches.has(batchKey)).toBe(false);
  });

  it('click on a collapsed diff hint row expands the diff', () => {
    routerStore.init(WORKFLOW_ROUTE);
    lifecycleStore.__testReset({ phase: 'implementing', status: 'running', startedAt: 0 });
    seedDiff();
    const snapshot = readConversationScrollSnapshot();
    const windowIndex = transcriptRows().findIndex((row) => rowText(row).includes('ctrl+d'));
    expect(windowIndex).toBeGreaterThanOrEqual(0);
    expect(conversationScrollStore.get().expandedDiffs.size).toBe(0);

    dispatchWorkflowPointer(
      pointerEvent('press', snapshot.contentRect.left, snapshot.contentRect.top + windowIndex),
    );

    expect(conversationScrollStore.get().expandedDiffs.has('implementer_generate_done:0')).toBe(
      true,
    );
  });

  it('resolves an activity disclosure click while a stage is live and the transcript is scrolled to the bottom', () => {
    routerStore.init(WORKFLOW_ROUTE);
    lifecycleStore.__testReset({ phase: 'implementing', status: 'running', startedAt: 0 });
    seedLiveDisclosureTranscript();
    const snapshot = readConversationScrollSnapshot();
    expect(snapshot.maxOffset).toBeGreaterThan(0);

    // The render (flow.tsx) and hit-test snapshot share the transcript-viewport projection, so the
    // disclosure the user actually sees lives in the same window the click path resolves against.
    const liveRows = transcriptViewportRows();
    const windowIndex = liveRows.findIndex((row) => row.kind === 'activity-more');
    expect(windowIndex).toBeGreaterThanOrEqual(0);
    const batchKey = (liveRows[windowIndex]?.key ?? '').replace(/-hidden$/, '');
    expect(batchKey).toMatch(/^activity-batch:/);
    expect(conversationScrollStore.get().expandedActivityBatches.has(batchKey)).toBe(false);

    dispatchWorkflowPointer(
      pointerEvent('press', snapshot.contentRect.left, snapshot.contentRect.top + windowIndex),
    );

    expect(conversationScrollStore.get().expandedActivityBatches.has(batchKey)).toBe(true);
  });

  it('click on a plain transcript row sets no focus and toggles nothing', () => {
    routerStore.init(WORKFLOW_ROUTE);
    lifecycleStore.__testReset({ phase: 'implementing', status: 'running', startedAt: 0 });
    seedTallTranscript();
    const snapshot = readConversationScrollSnapshot();

    dispatchWorkflowPointer(
      pointerEvent('press', snapshot.contentRect.left, snapshot.contentRect.top + 1),
    );

    expect(conversationScrollStore.get().expandedDiffs.size).toBe(0);
    expect(conversationScrollStore.get().expandedActivityBatches.size).toBe(0);
  });

  it('throttles a redundant valid hover update arriving within the window', () => {
    routerStore.init(WORKFLOW_ROUTE);
    lifecycleStore.__testReset({ phase: 'implementing', status: 'running', startedAt: 0 });
    const snapshot = readConversationScrollSnapshot();
    const { left, top } = snapshot.contentRect;
    dispatchWorkflowPointer(pointerEvent('move', left, top));
    expect(hoverStore.get()).toBe(0);

    dispatchWorkflowPointer(pointerEvent('move', left, top + 1));
    expect(hoverStore.get()).toBe(0);
  });
});
