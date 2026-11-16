import type { MouseAction, MouseEvent } from '../../../lib/terminal/filtered-stdin/types.js';
import { clickAt } from '../../../lib/terminal/mouse-zones.js';
import { hoverStore } from '../../../stores/ui/hover.js';
import { controlsStore } from '../../../stores/ui/controls.js';
import { completionStore } from '../../../stores/ui/completion.js';
import { conversationScrollStore } from '../../../stores/workflow/conversation-scroll.js';
import { streamingOutputStore } from '../../../stores/workflow/streaming-output.js';
import { getSections } from '../../../stores/workflow/actions/sections.js';
import { PROMPT_ZONE_Z } from '../components/approval-prompt/confirm.js';
import { RAIL_STAGES } from '../../../core/phases/rail.js';
import { hitRailStage, hitTranscriptRow } from '../layout/hit-test.js';
import {
  readConversationHoverSnapshot,
  readConversationScrollSnapshot,
  readRailSnapshot,
  type ConversationHoverSnapshot,
} from '../layout/snapshot.js';
import { readConversationRowActions } from '../conversation-rows/row-actions/read.js';
import { computeConversationRowScroll } from '../conversation-rows/scroll.js';
import { toggleFoldedRows } from '../conversation-rows/toggle-folded-rows.js';
import { readTranscriptTail } from '../conversation-rows/transcript-tail.js';

const HOVER_THROTTLE_MS = 16;
let lastHoverAt = 0;

export function _resetHoverThrottle(): void {
  lastHoverAt = 0;
}

type WorkflowHit = { surface: 'rail'; index: number } | { surface: 'conversation'; index: number };

function resolveWorkflowHit(
  sgrX: number,
  sgrY: number,
  hoverSnapshot: ConversationHoverSnapshot,
): WorkflowHit | null {
  const railIndex = hitRailStage(readRailSnapshot().zones, sgrX, sgrY);
  if (railIndex !== null) return { surface: 'rail', index: railIndex };
  // The review owns the body; nothing under it is a transcript row.
  if (controlsStore.get().inputMode === 'review') return null;
  const visibleCount = hoverSnapshot.viewportHeight;
  const index = hitTranscriptRow({
    rect: hoverSnapshot.contentRect,
    sgrX,
    sgrY,
    visibleCount,
  });
  return index === null ? null : { surface: 'conversation', index };
}

function scrollToRailStage(stageIndex: number): void {
  const { activeIndex } = readRailSnapshot();
  const target = activeIndex >= RAIL_STAGES.length ? RAIL_STAGES.length - 1 : activeIndex;
  const snapshot = readConversationScrollSnapshot();
  conversationScrollStore.scrollToBottom(snapshot.renderableCount);
  // The transcript runs oldest to newest while the rail runs Plan to Review: stage 0 anchors to the top
  // (maxOffset), the current stage to the just-set bottom. An in-between stage lands proportionally
  // on its slice of the transcript instead of collapsing every click to top-or-bottom.
  if (stageIndex >= target) return;
  const offset = Math.round((snapshot.maxOffset * (target - stageIndex)) / target);
  if (offset <= 0) return;
  conversationScrollStore.scrollUp({
    renderableCount: snapshot.renderableCount,
    totalHeight: snapshot.totalHeight,
    step: offset,
    maxOffset: snapshot.maxOffset,
  });
}

function handleHover(sgrX: number, sgrY: number): void {
  const hoverSnapshot = readConversationHoverSnapshot();
  const hit = resolveWorkflowHit(sgrX, sgrY, hoverSnapshot);
  if (!hit || hit.surface === 'rail') {
    hoverStore.clear();
    return;
  }

  const now = Date.now();
  if (now - lastHoverAt < HOVER_THROTTLE_MS) return;
  lastHoverAt = now;

  hoverStore.set(hit.index);
}

/** The key of the transcript row that the frame on screen shows at `windowIndex`. */
function drawnConversationRowKey(windowIndex: number): string | undefined {
  const snapshot = readConversationScrollSnapshot();
  const scroll = conversationScrollStore.get();
  const computed = computeConversationRowScroll({
    sections: getSections(),
    expandedDiffs: scroll.expandedDiffs,
    expandedActivityBatches: scroll.expandedActivityBatches,
    cols: snapshot.conversationWidth,
    viewportHeight: snapshot.transcriptViewportHeight,
    streaming: streamingOutputStore.get(),
    rawScrollOffset: scroll.scrollOffset,
    renderableCountAtScroll: scroll.renderableCountAtScroll,
    heightAtScroll: scroll.heightAtScroll,
    tail: readTranscriptTail(),
  });
  return windowIndex >= 0 ? computed.rows[windowIndex]?.key : undefined;
}

function activateConversationRow(rowKey: string): void {
  const action = readConversationRowActions().get(rowKey);
  if (action === undefined) return;
  if (action.type === 'toggle-diff') conversationScrollStore.toggleDiff(action.key);
  else toggleFoldedRows(action.key);
}

export function clearWorkflowHover(): void {
  hoverStore.clear();
}

export function handleWorkflowMouseMove(event: MouseEvent): void {
  if (completionStore.get().open) {
    hoverStore.clear();
    return;
  }
  handleHover(event.x, event.y);
}

export function handleWorkflowPromptMousePress(event: MouseEvent): MouseAction | undefined {
  return clickAt(event.x, event.y, { minZ: PROMPT_ZONE_Z });
}

/** Reads a press against the frame on screen; the action acts on what that frame showed there. */
export function handleWorkflowMousePress(event: MouseEvent): MouseAction | undefined {
  if (completionStore.get().open) return undefined;
  const click = clickAt(event.x, event.y);
  if (click) return click;
  const hit = resolveWorkflowHit(event.x, event.y, readConversationHoverSnapshot());
  if (!hit) return undefined;
  if (hit.surface === 'rail') return () => scrollToRailStage(hit.index);
  const rowKey = drawnConversationRowKey(hit.index);
  return rowKey === undefined ? undefined : () => activateConversationRow(rowKey);
}
