import { oneLineDisplayText, truncateTerminalDisplayText } from '../utils/display-text.js';
import type { QueuedMessage } from './schemas/workflow.js';

const QUEUE_PREVIEW_MAX_CELLS = 80;

export function formatQueueMessagePreview(text: string): string {
  return truncateTerminalDisplayText(oneLineDisplayText(text), QUEUE_PREVIEW_MAX_CELLS);
}

export function formatQueuedMessagePreview(
  message: Pick<QueuedMessage, 'origin' | 'question' | 'displayText'>,
): string {
  if (message.origin === 'clarification' && message.question) {
    return formatQueueMessagePreview(
      `clarification: ${message.question} -> ${message.displayText}`,
    );
  }
  return formatQueueMessagePreview(message.displayText);
}
