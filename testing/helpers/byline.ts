import { bylineParts } from '../../src/features/workflow/closed/byline.js';
import { openRunBylineParts } from '../../src/features/workflow/closed/open-byline.js';
import type { ConversationRowSegment } from '../../src/features/workflow/conversation-rows/types.js';

export function joinedByline(parts: readonly ConversationRowSegment[]): string {
  return parts.map((part) => part.text).join('');
}

export function bylineText(view: Parameters<typeof bylineParts>[0], width: number): string {
  return joinedByline(bylineParts(view, width));
}

// A local noon, so a reset at 17:00 the same day reads as a bare clock.
export const NOW = new Date(2026, 9, 10, 12, 0, 0, 0).getTime();

export function openRunByline(input: Parameters<typeof openRunBylineParts>[0]): string {
  return joinedByline(openRunBylineParts(input));
}
