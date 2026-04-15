import { describe, it, expect, vi } from 'vitest';
import { buildResumeContext, formatMessagesForCli, type ResumeMessage } from './transcript-rebuild.js';

vi.mock('../../core/sessions/log-reader.js', () => ({
  readMessages: vi.fn(),
}));

import { readMessages } from '../../core/sessions/log-reader.js';

const mockReadMessages = vi.mocked(readMessages);

describe('buildResumeContext', () => {
  it('returns empty messages with warning when persistTranscript is false', async () => {
    const result = await buildResumeContext('/proj', 'sess-1', false);
    expect(result.messages).toEqual([]);
    expect(result.warning).toBe('transcript-unavailable');
  });

  it('collects messages from log reader', async () => {
    async function* fakeMessages() {
      yield { ts: new Date().toISOString(), kind: 'message' as const, role: 'user' as const, text: 'hello', phase: 'planning' as const };
      yield { ts: new Date().toISOString(), kind: 'message' as const, role: 'assistant' as const, text: 'hi there', phase: 'planning' as const };
    }
    mockReadMessages.mockReturnValue(fakeMessages());
    const result = await buildResumeContext('/proj', 'sess-1', true);
    expect(result.messages).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
    ]);
    expect(result.warning).toBeUndefined();
  });
});

describe('formatMessagesForCli', () => {
  it('returns empty string for no messages', () => {
    expect(formatMessagesForCli([])).toBe('');
  });

  it('formats messages with role tags', () => {
    const messages: ResumeMessage[] = [
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
