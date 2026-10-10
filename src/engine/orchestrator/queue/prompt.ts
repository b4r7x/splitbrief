import type { QueuedMessage } from '../../../core/schemas/workflow.js';
import type { UserMessageInput } from '../../../core/types/user-input.js';
import type { Attachment } from '../../../core/schemas/attachment.js';

export function imagesFromMessages(
  messages: readonly { images: readonly Attachment[] }[],
): Attachment[] {
  return [
    ...new Map(
      messages.flatMap((message) => message.images).map((image) => [image.id, image]),
    ).values(),
  ];
}

export function formatMessageInput(message: Pick<UserMessageInput, 'text' | 'images'>): string {
  if (message.images.length === 0) return message.text;
  const paths = message.images.map((image) => `[image:${image.id}] = ${image.path}`).join('\n');
  return `${message.text}\n\nAttached image paths:\n${paths}`;
}

export function formatMessage(m: QueuedMessage): string {
  const prefix = m.possibleDuplicate
    ? 'You may have seen this message already during your last call:\n'
    : '';
  const text = formatMessageInput(m);
  if (m.origin === 'clarification' && m.question) {
    return `${prefix}[clarification answer during ${m.phase}]\nQ: ${m.question}\nA: ${text}\n[/clarification answer]`;
  }
  return `${prefix}[user also says during ${m.phase}]\n${text}\n[/user also says]`;
}

export function formatDrainedMessages(messages: QueuedMessage[]): string {
  if (messages.length === 0) return '';
  const header = `\n\n---\n**User messages received while you were working** (${messages.length}):\n\n`;
  const body = messages.map((m, i) => `${i + 1}. ${formatMessage(m)}`).join('\n');
  return header + body + '\n---\n\n';
}
