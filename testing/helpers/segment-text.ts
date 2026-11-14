import type { ConversationRowSegment } from '../../src/features/workflow/conversation-rows/types.js';

export function segmentText(segments: readonly ConversationRowSegment[]): string {
  return segments.map((segment) => segment.text).join('');
}
