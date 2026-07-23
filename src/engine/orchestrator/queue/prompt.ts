import type { QueuedMessage } from '../../../core/schemas/workflow.js';

export function formatMessage(m: QueuedMessage): string {
  if (m.origin === 'clarification' && m.question) {
    return `[clarification answer during ${m.phase}]\nQ: ${m.question}\nA: ${m.text}\n[/clarification answer]`;
  }
  return `[user also says during ${m.phase}]\n${m.text}\n[/user also says]`;
}

export function formatDrainedMessages(messages: QueuedMessage[]): string {
  if (messages.length === 0) return '';
  const header = `\n\n---\n**User messages received while you were working** (${messages.length}):\n\n`;
  const body = messages.map((m, i) => `${i + 1}. ${formatMessage(m)}`).join('\n');
  return header + body + '\n---\n\n';
}
