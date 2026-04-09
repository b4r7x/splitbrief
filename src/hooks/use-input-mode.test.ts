import { describe, it, expect } from 'vitest';
import { renderHook } from '#testing/helpers/render-hook.js';
import { useInputMode } from './use-input-mode.js';

describe('useInputMode', () => {
  it('initial mode is normal', () => {
    const { result, unmount } = renderHook(() => useInputMode());
    expect(result.current.mode).toBe('normal');
    expect(result.current.hint).toBe('');
    unmount();
  });

  it('setReviewMode changes mode to review', async () => {
    const { result, act, unmount } = renderHook(() => useInputMode());

    await act(() => {
      result.current.setReviewMode('Approve spec?');
    });

    expect(result.current.mode).toBe('review');
    expect(result.current.hint).toBe('Approve spec?');
    unmount();
  });

  it('resolve with object resolves the review promise', async () => {
    const { result, act, unmount } = renderHook(() => useInputMode());

    let resolved: { approved: boolean; comment?: string | undefined } | undefined;
    await act(() => {
      result.current.setReviewMode('Approve?').then((v) => {
        resolved = v;
      });
    });

    await act(() => {
      result.current.resolve({ approved: true, comment: 'lgtm' });
    });

    expect(resolved).toEqual({ approved: true, comment: 'lgtm' });
    expect(result.current.mode).toBe('normal');
    unmount();
  });

  it('setQuestionMode changes mode to question', async () => {
    const { result, act, unmount } = renderHook(() => useInputMode());

    await act(() => {
      result.current.setQuestionMode('What framework?');
    });

    expect(result.current.mode).toBe('question');
    expect(result.current.hint).toBe('What framework?');
    unmount();
  });

  it('resolve with string resolves the question promise', async () => {
    const { result, act, unmount } = renderHook(() => useInputMode());

    let resolved: string | undefined;
    await act(() => {
      result.current.setQuestionMode('Which DB?').then((v) => {
        resolved = v;
      });
    });

    await act(() => {
      result.current.resolve('postgres');
    });

    expect(resolved).toBe('postgres');
    expect(result.current.mode).toBe('normal');
    unmount();
  });

  it('resetMode returns to normal mode', async () => {
    const { result, act, unmount } = renderHook(() => useInputMode());

    await act(() => {
      result.current.setReviewMode('Approve?');
    });
    expect(result.current.mode).toBe('review');

    await act(() => {
      result.current.resetMode();
    });

    expect(result.current.mode).toBe('normal');
    unmount();
  });

  it('resetMode resolves pending review promise with { approved: false }', async () => {
    const { result, act, unmount } = renderHook(() => useInputMode());

    let resolved: { approved: boolean; comment?: string | undefined } | undefined;
    await act(() => {
      result.current.setReviewMode('Approve?').then((v) => {
        resolved = v;
      });
    });

    await act(() => {
      result.current.resetMode();
    });

    expect(resolved).toEqual({ approved: false });
    unmount();
  });

  it('resetMode resolves pending question promise with empty string', async () => {
    const { result, act, unmount } = renderHook(() => useInputMode());

    let resolved: string | undefined;
    await act(() => {
      result.current.setQuestionMode('Which DB?').then((v) => {
        resolved = v;
      });
    });

    await act(() => {
      result.current.resetMode();
    });

    expect(resolved).toBe('');
    unmount();
  });

  it('unmount resolves pending review promise with { approved: false }', async () => {
    const { result, act, unmount } = renderHook(() => useInputMode());

    let resolved: { approved: boolean; comment?: string | undefined } | undefined;
    await act(() => {
      result.current.setReviewMode('Approve?').then((v) => {
        resolved = v;
      });
    });

    unmount();
    await Promise.resolve();

    expect(resolved).toEqual({ approved: false });
  });

});
