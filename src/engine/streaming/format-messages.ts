import type { PriorMessage } from '../planners/types.js';

export function formatMessagesForCli(messages: PriorMessage[]): string {
  if (messages.length === 0) return '';
  const lines = messages.map(m => `[${m.role}] ${m.content}`);
  return `<!-- prior conversation -->\n${lines.join('\n')}\n<!-- /prior conversation -->\n\nNow continue from where you left off.\n\n`;
}
