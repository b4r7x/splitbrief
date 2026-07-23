import { describe, expect, it } from 'vitest';
import { formatCopyResult } from './types.js';

describe('formatCopyResult', () => {
  it.each([
    {
      result: 'osc52' as const,
      message: 'Copy escape sent; verify your clipboard (some terminals block it)',
    },
    { result: 'native' as const, message: 'Copied (native)' },
    { result: 'tmux-buffer' as const, message: 'Copied (tmux-buffer)' },
    { result: 'unavailable' as const, message: 'Could not copy' },
    { result: 'empty' as const, message: 'Nothing to copy' },
  ])('$result → $message', ({ result, message }) => {
    expect(formatCopyResult(result)).toBe(message);
  });
});
