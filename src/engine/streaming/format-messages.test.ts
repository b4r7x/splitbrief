import { describe, it, expect } from 'vitest';
import type { PriorMessage } from '../planners/types.js';
import { formatMessagesForCli } from './format-messages.js';

describe('formatMessagesForCli', () => {
  it('returns empty string for no messages', () => {
    expect(formatMessagesForCli([])).toBe('');
  });

  it('formats messages with role tags and continuation instruction', () => {
    const messages: PriorMessage[] = [
      { role: 'user', content: 'add auth' },
      { role: 'assistant', content: 'here is the plan' },
    ];
    const result = formatMessagesForCli(messages);
    expect(result).toContain('<!-- prior conversation -->');
    expect(result).toContain('[user] add auth');
    expect(result).toContain('[assistant] here is the plan');
    expect(result).toContain('<!-- /prior conversation -->');
    expect(result).toContain('continue from where you left off');
  });
});
