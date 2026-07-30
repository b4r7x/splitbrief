import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useCopyFeedback } from './use-copy-feedback.js';

const INITIAL_CLIPBOARD_DESCRIPTOR = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

describe('useCopyFeedback', () => {
  afterEach(() => {
    if (INITIAL_CLIPBOARD_DESCRIPTOR) {
      Object.defineProperty(navigator, 'clipboard', INITIAL_CLIPBOARD_DESCRIPTOR);
    } else {
      Reflect.deleteProperty(navigator, 'clipboard');
    }
    vi.restoreAllMocks();
  });

  it('ignores an older clipboard request that settles after the latest request', async () => {
    const firstWrite = Promise.withResolvers<void>();
    const secondWrite = Promise.withResolvers<void>();
    const writeText = vi
      .fn()
      .mockReturnValueOnce(firstWrite.promise)
      .mockReturnValueOnce(secondWrite.promise);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const { result } = renderHook(() => useCopyFeedback());

    const firstRequest = result.current.copyText('first');
    const secondRequest = result.current.copyText('second');

    await act(async () => {
      secondWrite.resolve();
      await secondRequest;
    });
    expect(result.current.copyState).toBe('copied');

    await act(async () => {
      firstWrite.reject(new Error('Older request failed'));
      await firstRequest;
    });
    expect(result.current.copyState).toBe('copied');
  });
});
