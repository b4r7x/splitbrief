import type { Key } from 'ink';
import type { Section } from '../../core/sections/event-sections.js';
import type { EngineEvent } from '../../engine/events/types.js';
import { resolveScrollKey, type ScrollKeyAction } from '../../core/keybindings/scroll.js';
import type { InputMode, OverlayType } from '../../core/navigation/types.js';
import { normalizeKeySignature } from '../../core/keybindings/normalize.js';
import {
  resolveKeyOwner,
  type FocusedKeySurface,
  type KeyAttachState,
} from '../../core/keybindings/resolver.js';

export type WorkflowKeyAction =
  | { type: 'none' }
  | { type: 'toggle-diff'; key: string }
  | { type: 'toggle-activity-batch'; key: string }
  | { type: 'open-cost-drilldown' }
  | { type: 'review-scroll'; offset: number }
  | {
      type: 'conversation-scroll-up';
      renderableCount: number;
      step: number;
      totalHeight: number;
      maxOffset: number;
    }
  | { type: 'conversation-scroll-down'; step: number }
  | { type: 'conversation-scroll-bottom'; renderableCount: number };

const NONE: WorkflowKeyAction = { type: 'none' };

export interface WorkflowCtrlChordsInput {
  input: string;
  key: Key;
  inputMode?: InputMode | undefined;
  overlay?: OverlayType | undefined;
  attachState?: KeyAttachState | undefined;
  composerFocus?: boolean | undefined;
  sections: Section<EngineEvent>[];
  findLatestDiff: (sections: Section<EngineEvent>[]) => string | null;
  findLatestActivityBatch: (sections: Section<EngineEvent>[]) => string | null;
}

export function handleWorkflowCtrlChords(options: WorkflowCtrlChordsInput): WorkflowKeyAction {
  const { input, key, sections, findLatestDiff, findLatestActivityBatch } = options;
  const owner = resolveKeyOwner({
    screen: 'workflow',
    inputMode: options.inputMode ?? 'normal',
    focus: 'workflow',
    overlay: options.overlay ?? 'none',
    attachState: options.attachState ?? 'local',
    composerFocus: options.composerFocus ?? false,
    key: normalizeKeySignature({ input, key }),
  });
  if (owner?.owner !== 'workflow') return NONE;

  if (owner.action === 'toggle-activity') {
    const activityKey = findLatestActivityBatch(sections);
    if (activityKey != null) return { type: 'toggle-activity-batch', key: activityKey };
    return NONE;
  }
  if (owner.action === 'toggle-diff') {
    const diffKey = findLatestDiff(sections);
    if (diffKey != null) return { type: 'toggle-diff', key: diffKey };
    return NONE;
  }
  if (owner.action === 'cost') return { type: 'open-cost-drilldown' };
  return NONE;
}

export interface ReviewScrollInput {
  input: string;
  key: Key;
  inputMode?: InputMode | undefined;
  overlay?: OverlayType | undefined;
  attachState?: KeyAttachState | undefined;
  composerFocus?: boolean | undefined;
  focus?: FocusedKeySurface | undefined;
  reviewScrollOffset: number;
  reviewLineCount: number;
  visibleHeight: number;
}

function reviewScrollOffsetForAction(
  action: ScrollKeyAction,
  reviewScrollOffset: number,
  maxOffset: number,
  pageStep: number,
): number {
  switch (action) {
    case 'line-up':
      return Math.max(0, reviewScrollOffset - 1);
    case 'line-down':
      return Math.min(maxOffset, reviewScrollOffset + 1);
    case 'page-up':
      return Math.max(0, reviewScrollOffset - pageStep);
    case 'page-down':
      return Math.min(maxOffset, reviewScrollOffset + pageStep);
    case 'top':
      return 0;
    case 'bottom':
      return maxOffset;
  }
}

export function handleReviewScroll(options: ReviewScrollInput): WorkflowKeyAction {
  const { input, key, reviewScrollOffset, reviewLineCount, visibleHeight } = options;
  const owner = resolveKeyOwner({
    screen: 'workflow',
    inputMode: options.inputMode ?? 'review',
    focus: options.focus ?? 'review',
    overlay: options.overlay ?? 'none',
    attachState: options.attachState ?? 'local',
    composerFocus: options.composerFocus ?? false,
    key: normalizeKeySignature({ input, key }),
  });
  if (owner?.owner !== 'review') return NONE;

  const scrollKey = resolveScrollKey({ input, key, lineKeys: 'shifted' });
  if (scrollKey === null) return NONE;

  const maxOffset = Math.max(0, reviewLineCount - visibleHeight);
  const pageStep = Math.max(1, visibleHeight);
  return {
    type: 'review-scroll',
    offset: reviewScrollOffsetForAction(scrollKey, reviewScrollOffset, maxOffset, pageStep),
  };
}

export interface ConversationScrollInput {
  input: string;
  key: Key;
  inputMode?: InputMode | undefined;
  overlay?: OverlayType | undefined;
  attachState?: KeyAttachState | undefined;
  composerFocus?: boolean | undefined;
  renderableCount: number;
  maxOffset: number;
  viewportHeight: number;
  totalHeight: number;
}

export function handleConversationScroll(options: ConversationScrollInput): WorkflowKeyAction {
  const { input, key, renderableCount, maxOffset, viewportHeight, totalHeight } = options;
  const owner = resolveKeyOwner({
    screen: 'workflow',
    inputMode: options.inputMode ?? 'normal',
    focus: 'workflow',
    overlay: options.overlay ?? 'none',
    attachState: options.attachState ?? 'local',
    composerFocus: options.composerFocus ?? false,
    key: normalizeKeySignature({ input, key }),
  });
  if (owner?.owner !== 'conversation-scroll') return NONE;

  const scrollKey = resolveScrollKey({ input, key, lineKeys: 'shifted' });
  if (scrollKey === null) return NONE;

  const pageStep = Math.max(1, viewportHeight - 1);

  switch (scrollKey) {
    case 'line-up':
      return { type: 'conversation-scroll-up', renderableCount, step: 1, totalHeight, maxOffset };
    case 'line-down':
      return { type: 'conversation-scroll-down', step: 1 };
    case 'page-up':
      return {
        type: 'conversation-scroll-up',
        renderableCount,
        step: pageStep,
        totalHeight,
        maxOffset,
      };
    case 'page-down':
      return { type: 'conversation-scroll-down', step: pageStep };
    case 'top':
      return {
        type: 'conversation-scroll-up',
        renderableCount,
        step: maxOffset,
        totalHeight,
        maxOffset,
      };
    case 'bottom':
      return { type: 'conversation-scroll-bottom', renderableCount };
  }
}
