import { sanitizeTerminalDisplayText, truncateTerminalDisplayText } from '../utils/display-text.js';
import type { QueuedMessage } from './schemas/workflow.js';

const QUEUE_PREVIEW_MAX_CELLS = 80;
const LINE_BOUNDARY_CONTROL_PATTERN = /[\t\n\v\f\r]+/g;

export function formatQueueMessagePreview(text: string): string {
  const oneLine = sanitizeTerminalDisplayText(text.replace(LINE_BOUNDARY_CONTROL_PATTERN, ' '))
    .replace(/\s+/g, ' ')
    .trim();
  return truncateTerminalDisplayText(oneLine, QUEUE_PREVIEW_MAX_CELLS);
}

export function formatQueuedMessagePreview(
  message: Pick<QueuedMessage, 'origin' | 'question' | 'text'>,
): string {
  if (message.origin === 'clarification' && message.question) {
    return formatQueueMessagePreview(`clarification: ${message.question} -> ${message.text}`);
  }
  return formatQueueMessagePreview(message.text);
}
