import { beforeEach, describe, expect, it, vi } from 'vitest';
import { wireAppMouse } from '../../../app/mouse.js';
import { _resetHoverThrottle } from './use-mouse-pointer.js';
import type { FilteredStdin, MouseEvent } from '../../../lib/terminal/filtered-stdin.js';
import { routerStore } from '../../../stores/navigation/router.js';
import { overlayStore } from '../../../stores/ui/overlay.js';
import { reviewStore } from '../../../stores/workflow/review.js';
import { focusStore } from '../../../stores/ui/focus.js';
import { hoverStore } from '../../../stores/ui/hover.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { conversationScrollStore } from '../../../stores/workflow/conversation-scroll.js';
import { eventsStore } from '../../../stores/workflow/events.js';
import { lifecycleStore } from '../../../stores/workflow/lifecycle.js';
import { resetWorkflow } from '../../../stores/workflow/actions.js';
import { inputHeightStore } from '../../../stores/ui/input-height.js';
import { _resetMouseZones, registerMouseZone } from '../../../lib/terminal/mouse-zones.js';
import {
  readBriefListSnapshot,
  readConversationScrollSnapshot,
  readRailSnapshot,
} from '../layout/snapshot.js';
import * as snapshot from '../layout/snapshot.js';
import { briefListTopOffset } from '../layout/hit-test.js';
import { SIMPLE_TASK_ROW_HEIGHT } from '../layout/brief-review.js';
import { computeConversationRowScroll } from '../conversation-rows/scroll.js';
import { activityBatchKey } from '../conversation-rows/activity-batch-key.js';
import { rowText } from '../conversation-rows/row-format.js';
import { getSections } from '../../../stores/workflow/actions.js';
import { streamingOutputStore } from '../../../stores/workflow/streaming-output.js';
import type { EngineEventOf } from '../../../engine/events/types.js';
import { makeImplementerGenerate, makePlannerText } from '#testing/helpers/events.js';

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

function transcriptRows() {
  const snapshot = readConversationScrollSnapshot();
  const scroll = conversationScrollStore.get();
  return computeConversationRowScroll({
    sections: getSections(),
    expandedDiffs: scroll.expandedDiffs,
    expandedActivityBatches: scroll.expandedActivityBatches,
    cols: snapshot.conversationWidth,
    viewportHeight: snapshot.conversationRect.height,
    rawScrollOffset: scroll.scrollOffset,
    renderableCountAtScroll: scroll.renderableCountAtScroll,
    heightAtScroll: scroll.heightAtScroll,
    streaming: streamingOutputStore.get(),
  }).rows;
}

function createMockFilteredStdin() {
  let listener: ((event: MouseEvent) => void) | undefined;
  return {
    filtered: {
      stdin: process.stdin as unknown as NodeJS.ReadStream,
      onMouse: (next: (event: MouseEvent) => void) => {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
      activate: () => {},
      isPasteActive: () => false,
      disable: () => {},
    } satisfies FilteredStdin,
    emit: (event: MouseEvent) => listener?.(event),
  };
}

function pointerEvent(type: MouseEvent['type'], x: number, y: number): MouseEvent {
  const button = type === 'wheel-up' ? 64 : type === 'wheel-down' ? 65 : type === 'move' ? 3 : 0;
  return { type, x, y, button, shift: false, meta: false, ctrl: false };
}

function openBriefReview(taskCount: number) {
  routerStore.init({ screen: 'workflow', feature: 'feat' });
  lifecycleStore.__testReset({ phase: 'reviewing-briefs' });
  reviewStore.setReviewFile('briefs.md', taskCount);
  const snapshot = readBriefListSnapshot();
  if (snapshot === null) throw new Error('expected a brief-list snapshot');
  return snapshot;
}

describe('wireAppMouse workflow pointer handling', () => {
  beforeEach(() => {
    routerStore.reset();
    overlayStore.reset();
    reviewStore.reset();
    focusStore.clear();
    hoverStore.clear();
    terminalSizeStore.__testReset({ rows: 30, cols: 80, isSmall: false });
    conversationScrollStore.reset();
    resetWorkflow();
    inputHeightStore.reset();
    lifecycleStore.__testReset();
    _resetMouseZones();
    _resetHoverThrottle();
  });

  it('click on a brief task row focuses it without moving the viewport', () => {
    const snapshot = openBriefReview(12);
    const windowIndex = 1;
    expect(snapshot.visibleCount).toBeGreaterThan(windowIndex);

    const sgrX = snapshot.rect.left;
    const listTop = snapshot.rect.top + briefListTopOffset({ hasLoadError: false });
    const mock = createMockFilteredStdin();
    const dispose = wireAppMouse(mock.filtered);
    mock.emit(pointerEvent('press', sgrX, listTop + windowIndex * SIMPLE_TASK_ROW_HEIGHT));

    expect(focusStore.get()).toEqual({
      region: 'brief',
      index: snapshot.previousCount + windowIndex,
    });
    // The clicked row is already on screen, so focusing it must not snap the viewport.
    expect(reviewStore.get().scrollOffset).toBe(0);
    dispose();
  });

  it('ignores a click outside any zone or row', () => {
    openBriefReview(12);
    const mock = createMockFilteredStdin();
    const dispose = wireAppMouse(mock.filtered);
    mock.emit(pointerEvent('press', 1, 1));

    expect(reviewStore.get().scrollOffset).toBe(0);
    expect(focusStore.get()).toBeNull();
    dispose();
  });

  it('ignores wheel events (the scroll handler owns them)', () => {
    openBriefReview(12);
    const mock = createMockFilteredStdin();
    const dispose = wireAppMouse(mock.filtered);
    mock.emit(pointerEvent('wheel-up', 5, 10));
    mock.emit(pointerEvent('wheel-down', 5, 10));

    expect(reviewStore.get().scrollOffset).toBe(0);
    expect(focusStore.get()).toBeNull();
    dispose();
  });

  it('opens the cost drilldown when a registered footer zone is clicked', () => {
    routerStore.init({ screen: 'workflow', feature: 'feat' });
    registerMouseZone({
      id: 'cost',
      left: 60,
      right: 70,
      top: 28,
      bottom: 28,
      z: 10,
      onClick: () => overlayStore.open('cost-drilldown'),
    });
    const mock = createMockFilteredStdin();
    const dispose = wireAppMouse(mock.filtered);
    mock.emit(pointerEvent('press', 65, 28));

    expect(overlayStore.get().active).toBe('cost-drilldown');
    dispose();
  });

  it('ignores a release event so X10 button-3 releases do not click a zone', () => {
    routerStore.init({ screen: 'workflow', feature: 'feat' });
    const onClick = vi.fn();
    registerMouseZone({ id: 'z', left: 1, right: 80, top: 5, bottom: 5, z: 5, onClick });
    const mock = createMockFilteredStdin();
    const dispose = wireAppMouse(mock.filtered);
    mock.emit(pointerEvent('release', 10, 5));

    expect(onClick).not.toHaveBeenCalled();
    dispose();
  });

  it('click on the active rail stage scrolls the transcript to the bottom without setting focus', () => {
    routerStore.init({ screen: 'workflow', feature: 'feat' });
    lifecycleStore.__testReset({ phase: 'implementing', status: 'running', startedAt: 0 });
    seedTallTranscript();
    const snapshot = readConversationScrollSnapshot();
    // Pre-scroll up so snapping back to the bottom is an observable state change, not a silent no-op.
    conversationScrollStore.__testReset({
      scrollOffset: 5,
      renderableCountAtScroll: 1,
      heightAtScroll: 9,
    });
    const buildZone = readRailSnapshot().zones.find((zone) => zone.index === 3);
    if (!buildZone) throw new Error('expected a build rail zone');
    const mock = createMockFilteredStdin();
    const dispose = wireAppMouse(mock.filtered);
    mock.emit(pointerEvent('press', buildZone.left, buildZone.top));

    const scroll = conversationScrollStore.get();
    expect(scroll.scrollOffset).toBe(0);
    expect(scroll.renderableCountAtScroll).toBe(snapshot.renderableCount);
    expect(focusStore.get()).toBeNull();
    dispose();
  });

  it('routes distinct rail stages to distinct transcript scroll destinations', () => {
    routerStore.init({ screen: 'workflow', feature: 'feat' });
    terminalSizeStore.__testReset({ cols: 120, rows: 40, isSmall: false });
    lifecycleStore.__testReset({ phase: 'analyzing', status: 'running', startedAt: 0 });
    seedTallTranscript();
    const maxOffset = readConversationScrollSnapshot().maxOffset;
    // The full vertical rail must expose every stage as its own hotspot for the routing to differ.
    expect(maxOffset).toBeGreaterThanOrEqual(2);
    const zones = readRailSnapshot().zones;
    const zoneFor = (index: number) => {
      const zone = zones.find((z) => z.index === index);
      if (!zone) throw new Error(`expected a rail zone for stage ${index}`);
      return zone;
    };

    const mock = createMockFilteredStdin();
    const dispose = wireAppMouse(mock.filtered);

    const clickStage = (index: number): number => {
      conversationScrollStore.reset();
      const zone = zoneFor(index);
      mock.emit(pointerEvent('press', zone.left, zone.top));
      return conversationScrollStore.get().scrollOffset;
    };

    // analyzing → active stage is `briefs` (index 2): the earliest stage anchors to the top
    // (maxOffset), an in-between stage lands proportionally, and the active stage sits at the bottom.
    const spec = clickStage(0);
    const plan = clickStage(1);
    const briefs = clickStage(2);

    expect(spec).toBe(maxOffset);
    expect(plan).toBe(Math.round(maxOffset / 2));
    expect(briefs).toBe(0);
    expect(new Set([spec, plan, briefs]).size).toBe(3);
    expect(focusStore.get()).toBeNull();
    dispose();
  });

  it('sets the hover store on a move over a brief row', () => {
    const snapshot = openBriefReview(12);
    const listTop = snapshot.rect.top + briefListTopOffset({ hasLoadError: false });
    const mock = createMockFilteredStdin();
    const dispose = wireAppMouse(mock.filtered);
    mock.emit(pointerEvent('move', snapshot.rect.left, listTop));

    expect(hoverStore.get()).toEqual({ surface: 'brief', index: snapshot.previousCount });
    dispose();
  });

  it('clears hover on a move over the click-only rail', () => {
    routerStore.init({ screen: 'workflow', feature: 'feat' });
    lifecycleStore.__testReset({ phase: 'implementing', status: 'running', startedAt: 0 });
    const railZone = readRailSnapshot().zones[0];
    if (!railZone) throw new Error('expected a rail zone');
    // Seed a stale tint so the assertion proves the rail move actively clears it.
    hoverStore.set('conversation', 5);
    const mock = createMockFilteredStdin();
    const dispose = wireAppMouse(mock.filtered);
    mock.emit(pointerEvent('move', railZone.left, railZone.top));

    expect(hoverStore.get()).toBeNull();
    dispose();
  });

  it('clears hover on a move over empty space', () => {
    openBriefReview(12);
    hoverStore.set('brief', 3);
    const mock = createMockFilteredStdin();
    const dispose = wireAppMouse(mock.filtered);
    mock.emit(pointerEvent('move', 1, 1));

    expect(hoverStore.get()).toBeNull();
    dispose();
  });

  it('sets a conversation hover on a move over the transcript', () => {
    routerStore.init({ screen: 'workflow', feature: 'feat' });
    lifecycleStore.__testReset({ phase: 'implementing', status: 'running', startedAt: 0 });
    const snapshot = readConversationScrollSnapshot();
    const mock = createMockFilteredStdin();
    const dispose = wireAppMouse(mock.filtered);
    mock.emit(pointerEvent('move', snapshot.conversationRect.left, snapshot.conversationRect.top));

    expect(hoverStore.get()).toEqual({ surface: 'conversation', index: 0 });
    dispose();
  });

  it('clears hover on an invalid move even inside the throttle window', () => {
    const snapshot = openBriefReview(12);
    const listTop = snapshot.rect.top + briefListTopOffset({ hasLoadError: false });
    const mock = createMockFilteredStdin();
    const dispose = wireAppMouse(mock.filtered);
    mock.emit(pointerEvent('move', snapshot.rect.left, listTop));
    expect(hoverStore.get()).toEqual({ surface: 'brief', index: snapshot.previousCount });

    // A second move arriving within HOVER_THROTTLE_MS lands on empty space. Clearing is never
    // throttled, so the stale tint must not survive the invalid move.
    mock.emit(pointerEvent('move', 1, 1));
    expect(hoverStore.get()).toBeNull();
    dispose();
  });

  it('click on a +N more activity row expands the batch', () => {
    routerStore.init({ screen: 'workflow', feature: 'feat' });
    lifecycleStore.__testReset({ phase: 'implementing', status: 'running', startedAt: 0 });
    const batchKey = seedActivityBatch();
    const snapshot = readConversationScrollSnapshot();
    const windowIndex = transcriptRows().findIndex((row) => row.kind === 'activity-more');
    expect(windowIndex).toBeGreaterThanOrEqual(0);
    expect(conversationScrollStore.get().expandedActivityBatches.has(batchKey)).toBe(false);

    const mock = createMockFilteredStdin();
    const dispose = wireAppMouse(mock.filtered);
    mock.emit(
      pointerEvent(
        'press',
        snapshot.conversationRect.left,
        snapshot.conversationRect.top + windowIndex,
      ),
    );

    expect(conversationScrollStore.get().expandedActivityBatches.has(batchKey)).toBe(true);
    expect(focusStore.get()).toBeNull();
    dispose();
  });

  it('click on the collapse activity row collapses the expanded batch', () => {
    routerStore.init({ screen: 'workflow', feature: 'feat' });
    lifecycleStore.__testReset({ phase: 'implementing', status: 'running', startedAt: 0 });
    const batchKey = seedActivityBatch();
    conversationScrollStore.toggleActivityBatch(batchKey);
    expect(conversationScrollStore.get().expandedActivityBatches.has(batchKey)).toBe(true);

    const snapshot = readConversationScrollSnapshot();
    const windowIndex = transcriptRows().findIndex((row) => row.kind === 'activity-more');
    expect(windowIndex).toBeGreaterThanOrEqual(0);

    const mock = createMockFilteredStdin();
    const dispose = wireAppMouse(mock.filtered);
    mock.emit(
      pointerEvent(
        'press',
        snapshot.conversationRect.left,
        snapshot.conversationRect.top + windowIndex,
      ),
    );

    expect(conversationScrollStore.get().expandedActivityBatches.has(batchKey)).toBe(false);
    dispose();
  });

  it('click on a collapsed diff hint row expands the diff', () => {
    routerStore.init({ screen: 'workflow', feature: 'feat' });
    lifecycleStore.__testReset({ phase: 'implementing', status: 'running', startedAt: 0 });
    seedDiff();
    const snapshot = readConversationScrollSnapshot();
    const windowIndex = transcriptRows().findIndex((row) => rowText(row).includes('ctrl+d'));
    expect(windowIndex).toBeGreaterThanOrEqual(0);
    expect(conversationScrollStore.get().expandedDiffs.size).toBe(0);

    const mock = createMockFilteredStdin();
    const dispose = wireAppMouse(mock.filtered);
    mock.emit(
      pointerEvent(
        'press',
        snapshot.conversationRect.left,
        snapshot.conversationRect.top + windowIndex,
      ),
    );

    expect(conversationScrollStore.get().expandedDiffs.has('implementer_generate_done:0')).toBe(
      true,
    );
    expect(focusStore.get()).toBeNull();
    dispose();
  });

  it('click on a plain transcript row sets no focus and toggles nothing', () => {
    routerStore.init({ screen: 'workflow', feature: 'feat' });
    lifecycleStore.__testReset({ phase: 'implementing', status: 'running', startedAt: 0 });
    seedTallTranscript();
    const snapshot = readConversationScrollSnapshot();

    const mock = createMockFilteredStdin();
    const dispose = wireAppMouse(mock.filtered);
    mock.emit(
      pointerEvent('press', snapshot.conversationRect.left, snapshot.conversationRect.top + 1),
    );

    expect(conversationScrollStore.get().expandedDiffs.size).toBe(0);
    expect(conversationScrollStore.get().expandedActivityBatches.size).toBe(0);
    expect(focusStore.get()).toBeNull();
    dispose();
  });

  it('throttles a redundant valid hover update arriving within the window', () => {
    const snapshot = openBriefReview(12);
    const listTop = snapshot.rect.top + briefListTopOffset({ hasLoadError: false });
    expect(snapshot.visibleCount).toBeGreaterThan(1);
    const mock = createMockFilteredStdin();
    const dispose = wireAppMouse(mock.filtered);
    mock.emit(pointerEvent('move', snapshot.rect.left, listTop));
    expect(hoverStore.get()).toEqual({ surface: 'brief', index: snapshot.previousCount });

    // A second valid move to the next row within the throttle window is dropped, so the hover stays
    // on the first row rather than re-running on every high-frequency move event.
    mock.emit(pointerEvent('move', snapshot.rect.left, listTop + SIMPLE_TASK_ROW_HEIGHT));
    expect(hoverStore.get()).toEqual({ surface: 'brief', index: snapshot.previousCount });
    dispose();
  });

  it('resolves transcript hover from the lightweight snapshot, not full scroll projection', () => {
    routerStore.init({ screen: 'workflow', feature: 'feat' });
    lifecycleStore.__testReset({ phase: 'implementing', status: 'running', startedAt: 0 });
    seedTallTranscript();
    const layout = readConversationScrollSnapshot();
    const hoverSpy = vi.spyOn(snapshot, 'readConversationHoverSnapshot');
    const scrollSpy = vi.spyOn(snapshot, 'readConversationScrollSnapshot');
    const mock = createMockFilteredStdin();
    const dispose = wireAppMouse(mock.filtered);

    mock.emit(
      pointerEvent(
        'move',
        layout.conversationRect.left,
        layout.conversationRect.top + layout.stickyLeadingRows,
      ),
    );

    expect(hoverSpy.mock.calls.length).toBeGreaterThan(0);
    expect(scrollSpy).not.toHaveBeenCalled();
    hoverSpy.mockRestore();
    scrollSpy.mockRestore();
    dispose();
  });
});
