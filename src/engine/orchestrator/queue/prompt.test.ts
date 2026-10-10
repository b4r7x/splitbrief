import { plainUserMessage } from '../../../core/types/user-input.js';

import { describe, it, expect } from 'vitest';
import type { QueuedMessage } from '../../../core/schemas/workflow.js';
import { formatDrainedMessages, formatMessage } from './prompt.js';
import { makeMessage } from '#testing/helpers/queue.js';

describe('formatMessage', () => {
  it('keeps expanded attachment text and identifies each image by its path', () => {
    const message = {
      ...makeMessage('Use @notes.md\n\nPELICAN-42'),
      images: [
        {
          id: 'image-1',
          kind: 'image' as const,
          path: '/outside/shot.png',
          mimeType: 'image/png',
          sizeBytes: 5,
        },
      ],
      attachedInputs: [
        { kind: 'text' as const, path: '/outside/notes.md' },
        { kind: 'image' as const, path: '/outside/shot.png' },
      ],
    };
    const prompt = formatDrainedMessages([message]);
    expect(prompt).toContain('Use @notes.md\n\nPELICAN-42');
    expect(prompt).toContain('[image:image-1] = /outside/shot.png');
  });

  it.each(['user-input', 'clarification'] as const)(
    'prefixes an uncertain %s message with a duplicate warning',
    (origin) => {
      const message = {
        ...makeMessage('use UTC'),
        origin,
        question: 'Which timezone?',
        possibleDuplicate: true,
      };
      expect(formatMessage(message)).toMatch(
        /^You may have seen this message already during your last call:\n/,
      );
      expect(formatDrainedMessages([message])).toContain(
        '1. You may have seen this message already during your last call:\n',
      );
    },
  );

  it('formats user-input message with [user also says] wrapper', () => {
    const msg: QueuedMessage = {
      id: 'msg-1',
      ...plainUserMessage('add logging'),
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
      ...plainUserMessage('Yes, JWT'),
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
        ...plainUserMessage('add logging'),
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
        ...plainUserMessage('first'),
        queuedAt: new Date().toISOString(),
        phase: 'researching',
        deliveredViaNative: false,
        nativeDeliveryState: 'pending',
      },
      {
        id: 'msg-2',
        ...plainUserMessage('second'),
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
