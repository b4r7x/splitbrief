import type { MouseEvent } from '../../../lib/terminal/filtered-stdin.js';
import { hitTopmostZone } from '../../../lib/terminal/mouse-zones.js';
import { focusStore } from '../../../stores/ui/focus.js';
import { hoverStore } from '../../../stores/ui/hover.js';
import { reviewStore } from '../../../stores/workflow/review.js';
import { conversationScrollStore } from '../../../stores/workflow/conversation-scroll.js';
import { streamingOutputStore } from '../../../stores/workflow/streaming-output.js';
import { getSections } from '../../../stores/workflow/actions.js';
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
import { buildConversationRowActions } from '../conversation-rows/build.js';
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

function withinRect(
  rect: { left: number; right: number; top: number; bottom: number },
  sgrX: number,
  sgrY: number,
): boolean {
  return sgrX >= rect.left && sgrX <= rect.right && sgrY >= rect.top && sgrY <= rect.bottom;
}

function resolveWorkflowHit(
  sgrX: number,
  sgrY: number,
  hoverSnapshot: ConversationHoverSnapshot,
): WorkflowHit | null {
  const railIndex = hitRailStage(readRailSnapshot().zones, sgrX, sgrY);
  if (railIndex !== null) return { surface: 'rail', index: railIndex };
  const brief = readBriefListSnapshot();
  if (brief) {
    const index = hitBriefTaskRow({
      rect: brief.rect,
      sgrX,
      sgrY,
      hasLoadError: brief.hasLoadError,
      visibleCount: brief.visibleCount,
      previousCount: brief.previousCount,
    });
    return index === null ? null : { surface: 'brief', index };
  }
  if (reviewStore.get().filePath) return null;
  const visibleCount = hoverSnapshot.stickyLeadingRows + hoverSnapshot.viewportHeight;
  const index = hitTranscriptRow({
    rect: hoverSnapshot.conversationRect,
    sgrX,
    sgrY,
    visibleCount,
  });
  return index === null ? null : { surface: 'conversation', index };
}

function isOverWorkflowHoverSurface(
  sgrX: number,
  sgrY: number,
  hoverSnapshot: ConversationHoverSnapshot,
): boolean {
  const brief = readBriefListSnapshot();
  if (brief && withinRect(brief.rect, sgrX, sgrY)) return true;
  if (reviewStore.get().filePath) return false;
  return withinRect(hoverSnapshot.conversationRect, sgrX, sgrY);
}

function scrollToRailStage(stageIndex: number): void {
  const { activeIndex } = readRailSnapshot();
  const target = activeIndex >= RAIL_STAGES.length ? RAIL_STAGES.length - 1 : activeIndex;
  const snapshot = readConversationScrollSnapshot();
  conversationScrollStore.scrollToBottom(snapshot.renderableCount);
  // The transcript runs oldest to newest while the rail runs spec to verify: stage 0 anchors to the top
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
  const railIndex = hitRailStage(readRailSnapshot().zones, sgrX, sgrY);
  if (railIndex !== null) {
    hoverStore.clear();
    return;
  }

  const hoverSnapshot = readConversationHoverSnapshot();
  if (!isOverWorkflowHoverSurface(sgrX, sgrY, hoverSnapshot)) {
    hoverStore.clear();
    return;
  }

  const now = Date.now();
  if (now - lastHoverAt < HOVER_THROTTLE_MS) return;
  lastHoverAt = now;

  const hit = resolveWorkflowHit(sgrX, sgrY, hoverSnapshot);
  if (!hit || hit.surface === 'rail') {
    hoverStore.clear();
    return;
  }
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
  handleHover(event.x, event.y);
}

export function handleWorkflowPromptMousePress(event: MouseEvent): void {
  hitTopmostZone(event.x, event.y, { minZ: PROMPT_ZONE_Z })?.onClick?.();
}

export function handleWorkflowMousePress(event: MouseEvent): void {
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
