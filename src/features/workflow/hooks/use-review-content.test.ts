import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '#testing/helpers/render-hook.js';
import { feedbackStore } from '../../../stores/ui/feedback.js';
import { reviewStore } from '../../../stores/workflow/review.js';

const mockReadFile = vi.fn<(path: string, encoding: string) => Promise<string>>();

vi.mock('node:fs/promises', () => ({
  default: { readFile: mockReadFile },
}));

const { useReviewContent } = await import('./use-review-content.js');

beforeEach(() => {
  mockReadFile.mockReset();
  feedbackStore.reset();
  reviewStore.clearReview();
});

describe('useReviewContent', () => {
  it('returns file content after successful read', async () => {
    mockReadFile.mockResolvedValueOnce('hello world');

    const { result, act, unmount } = renderHook(() =>
      useReviewContent('/some/file.md'),
    );

    await act(() => {});

    expect(result.current).toBe('hello world');
    expect(reviewStore.get().lineCount).toBe(1);
    unmount();
  });

  it('returns empty string and sets error on read failure', async () => {
    mockReadFile.mockRejectedValueOnce(new Error('ENOENT: no such file'));

    const { result, act, unmount } = renderHook(() =>
      useReviewContent('/nonexistent/file.md'),
    );

    await act(() => {});

    expect(result.current).toBe('');
    expect(reviewStore.get().lineCount).toBe(0);
    expect(feedbackStore.get().isError).toBe(true);
    expect(feedbackStore.get().message).toContain('/nonexistent/file.md');
    unmount();
  });

  it('returns empty string and resets lineCount when filePath is null', async () => {
    const { result, unmount } = renderHook(() => useReviewContent(null));

    expect(result.current).toBe('');
    expect(reviewStore.get().lineCount).toBe(0);
    expect(mockReadFile).not.toHaveBeenCalled();
    unmount();
  });

  it('ignores stale read result when path changes before resolution', async () => {
    let resolveFirst!: (v: string) => void;
    const firstRead = new Promise<string>(res => { resolveFirst = res; });
    mockReadFile
      .mockReturnValueOnce(firstRead)
      .mockResolvedValueOnce('new content');

    let currentPath = '/first.md';
    const { result, act, unmount } = renderHook(() =>
      useReviewContent(currentPath),
    );

    // Trigger second render with new path before first resolves
    await act(() => {
      currentPath = '/second.md';
    });

    // Now resolve the first (stale) read — should be a no-op
    await act(() => {
      resolveFirst('stale content');
    });

    // Content should reflect the second file, not the stale first result
    expect(result.current).not.toBe('stale content');
    unmount();
  });
});
