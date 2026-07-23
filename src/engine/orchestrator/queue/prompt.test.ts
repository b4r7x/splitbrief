import { describe, it, expect } from 'vitest';
import type { QueuedMessage } from '../../../core/schemas/workflow.js';
import { formatDrainedMessages, formatMessage } from './prompt.js';

describe('formatMessage', () => {
  it('formats user-input message with [user also says] wrapper', () => {
    const msg: QueuedMessage = {
      id: 'msg-1',
      text: 'add logging',
      queuedAt: new Date().toISOString(),
      phase: 'researching',
      deliveredViaNative: false,
      nativeDeliveryState: 'pending',
    };
    const result = formatMessage(msg);
    expect(result).toContain('[user also says during researching]');
    expect(result).toContain('add logging');
    expect(result).toContain('[/user also says]');
  });

  it('formats clarification message with [clarification answer] wrapper', () => {
    const msg: QueuedMessage = {
      id: 'msg-2',
      text: 'Yes, JWT',
      queuedAt: new Date().toISOString(),
      phase: 'specifying',
      deliveredViaNative: false,
      nativeDeliveryState: 'pending',
      origin: 'clarification',
      question: 'Use JWT?',
    };
    const result = formatMessage(msg);
    expect(result).toContain('[clarification answer during specifying]');
    expect(result).toContain('Q: Use JWT?');
    expect(result).toContain('A: Yes, JWT');
    expect(result).toContain('[/clarification answer]');
  });
});

describe('formatDrainedMessages', () => {
  it('returns empty string for empty array', () => {
    expect(formatDrainedMessages([])).toBe('');
  });

  it('formats single message', () => {
    const messages: QueuedMessage[] = [
      {
        id: 'msg-1',
        text: 'add logging',
        queuedAt: new Date().toISOString(),
        phase: 'researching',
        deliveredViaNative: false,
        nativeDeliveryState: 'pending',
      },
    ];

    const result = formatDrainedMessages(messages);

    expect(result).toContain('add logging');
    expect(result).toContain('User messages received while you were working');
  });

  it('formats multiple messages with numbered list', () => {
    const messages: QueuedMessage[] = [
      {
        id: 'msg-1',
        text: 'first',
        queuedAt: new Date().toISOString(),
        phase: 'researching',
        deliveredViaNative: false,
        nativeDeliveryState: 'pending',
      },
      {
        id: 'msg-2',
        text: 'second',
        queuedAt: new Date().toISOString(),
        phase: 'specifying',
        deliveredViaNative: false,
        nativeDeliveryState: 'pending',
      },
    ];

    const result = formatDrainedMessages(messages);

    expect(result).toContain('first');
    expect(result).toContain('second');
    expect(result).toContain('(2)');
  });
});
