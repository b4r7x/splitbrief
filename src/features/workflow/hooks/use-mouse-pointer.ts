import type { MouseEvent } from '../../../lib/terminal/filtered-stdin/types.js';
import { hitTopmostZone } from '../../../lib/terminal/mouse-zones.js';
import { focusStore } from '../../../stores/ui/focus.js';
import { hoverStore } from '../../../stores/ui/hover.js';
import { controlsStore } from '../../../stores/ui/controls.js';
import { completionStore } from '../../../stores/ui/completion.js';
import { reviewStore } from '../../../stores/workflow/review.js';
import { conversationScrollStore } from '../../../stores/workflow/conversation-scroll.js';
import { streamingOutputStore } from '../../../stores/workflow/streaming-output.js';
import { getSections } from '../../../stores/workflow/actions/sections.js';
import { PROMPT_ZONE_Z } from '../components/approval-prompt.js';
import { RAIL_STAGES } from '../layout/chrome-rows.js';
import { hitBriefTaskRow, hitRailStage, hitTranscriptRow } from '../layout/hit-test.js';
import {
  readBriefListSnapshot,
  readConversationHoverSnapshot,
  readConversationScrollSnapshot,
  readRailSnapshot,
  type ConversationHoverSnapshot,
} from '../layout/snapshot.js';
import { buildConversationRowActions } from '../conversation-rows/row-actions.js';
import { computeConversationRowScroll } from '../conversation-rows/scroll.js';

const HOVER_THROTTLE_MS = 16;
let lastHoverAt = 0;

export function _resetHoverThrottle(): void {
  lastHoverAt = 0;
}

type WorkflowHit =
  | { surface: 'rail'; index: number }
  | { surface: 'brief'; index: number }
  | { surface: 'conversation'; index: number };

function resolveWorkflowHit(
  sgrX: number,
  sgrY: number,
  hoverSnapshot: ConversationHoverSnapshot,
): WorkflowHit | null {
  const railIndex = hitRailStage(readRailSnapshot().zones, sgrX, sgrY);
  if (railIndex !== null) return { surface: 'rail', index: railIndex };
  if (controlsStore.get().inputMode === 'review') {
    if (reviewStore.get().filePath === null) return null;
    const brief = readBriefListSnapshot();
    if (brief === null) return null;
    const index = hitBriefTaskRow({
      rect: brief.rect,
      sgrX,
      sgrY,
      taskTopOffset: brief.taskTopOffset,
      visibleCount: brief.visibleCount,
      previousCount: brief.previousCount,
    });
    return index === null ? null : { surface: 'brief', index };
  }
  const visibleCount = hoverSnapshot.stickyLeadingRows + hoverSnapshot.viewportHeight;
  const index = hitTranscriptRow({
    rect: hoverSnapshot.conversationRect,
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
  // The transcript runs oldest to newest while the rail runs Plan to Verify: stage 0 anchors to the top
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

  hoverStore.set(hit.surface, hit.index);
}

function activateConversationRow(windowIndex: number): void {
  const snapshot = readConversationScrollSnapshot();
  const scroll = conversationScrollStore.get();
  const inputs = {
    sections: getSections(),
    expandedDiffs: scroll.expandedDiffs,
    expandedActivityBatches: scroll.expandedActivityBatches,
    cols: snapshot.conversationWidth,
    viewportHeight: snapshot.transcriptViewportHeight,
    streaming: streamingOutputStore.get(),
  };
  const computed = computeConversationRowScroll({
    ...inputs,
    rawScrollOffset: scroll.scrollOffset,
    renderableCountAtScroll: scroll.renderableCountAtScroll,
    heightAtScroll: scroll.heightAtScroll,
  });
  // The transcript paints below the sticky completed-task summary (header + rows + trailing blank);
  // its height is the only part the scroll viewport reserves, so deriving the leading offset from it
  // keeps the click aligned with the rows the user sees.
  const transcriptIndex = windowIndex - snapshot.stickyLeadingRows;
  const clickedRow = transcriptIndex >= 0 ? computed.rows[transcriptIndex] : undefined;
  if (clickedRow === undefined) return;
  const action = buildConversationRowActions({
    ...inputs,
    viewportHeight: computed.viewportHeight,
  }).get(clickedRow.key);
  if (action === undefined) return;
  if (action.type === 'toggle-diff') conversationScrollStore.toggleDiff(action.key);
  else conversationScrollStore.toggleActivityBatch(action.key);
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

export function handleWorkflowPromptMousePress(event: MouseEvent): void {
  hitTopmostZone(event.x, event.y, { minZ: PROMPT_ZONE_Z })?.onClick?.();
}

export function handleWorkflowMousePress(event: MouseEvent): void {
  if (completionStore.get().open) return;
  const zone = hitTopmostZone(event.x, event.y);
  if (zone) {
    zone.onClick?.();
    return;
  }
  const hit = resolveWorkflowHit(event.x, event.y, readConversationHoverSnapshot());
  if (!hit) return;
  if (hit.surface === 'rail') {
    scrollToRailStage(hit.index);
    return;
  }
  if (hit.surface === 'brief') {
    focusStore.set('brief', hit.index);
    return;
  }
  activateConversationRow(hit.index);
}
