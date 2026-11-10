import type { ConversationRowBlock } from './types.js';

let tail: readonly ConversationRowBlock[] = [];

/**
 * The blocks the screen appended after the run's own events. The screen paints them, and the keys
 * and the pointer read the transcript from outside React: without these they measure a transcript
 * that stops at the last event, and a fold in a tail block cannot be reached.
 */
export function publishTranscriptTail(blocks: readonly ConversationRowBlock[]): void {
  tail = blocks;
}

export function readTranscriptTail(): readonly ConversationRowBlock[] {
  return tail;
}
