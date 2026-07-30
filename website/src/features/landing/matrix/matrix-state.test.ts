import { createElement } from 'react';
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SELECTION, type PairingSelection } from './pairings.js';
import {
  INITIAL_MATRIX_STATE,
  PATCH_PULSE_MS,
  matrixStateReducer,
  pairingAnnouncement,
} from './matrix-state.js';
import { usePairingSelection } from './use-pairing-selection.js';

const ALTERNATE_SELECTION = {
  plannerId: 'codex',
  implementerId: 'groq',
} satisfies PairingSelection;

const LATEST_SELECTION = {
  plannerId: 'aider',
  implementerId: 'deepseek',
} satisfies PairingSelection;

describe('matrix selection state', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('starts with the default pin and output without a pulse or announcement', () => {
    const { result } = renderHook(() => usePairingSelection({ reducedMotion: false }));

    expect(result.current.selected).toEqual(DEFAULT_SELECTION);
    expect(result.current.output).toEqual(DEFAULT_SELECTION);
    expect(result.current.pulse).toBeNull();
    expect(result.current.announcement).toBe('');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('treats selecting the seated pair as a strict no-op', () => {
    const { result } = renderHook(() => usePairingSelection({ reducedMotion: false }));

    act(() => result.current.select(DEFAULT_SELECTION));

    expect(result.current.selected).toEqual(DEFAULT_SELECTION);
    expect(result.current.output).toEqual(DEFAULT_SELECTION);
    expect(result.current.pulse).toBeNull();
    expect(result.current.announcement).toBe('');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('seats immediately, then commits output and status after the pulse', () => {
    const { result } = renderHook(() => usePairingSelection({ reducedMotion: false }));

    act(() => result.current.select(ALTERNATE_SELECTION));

    expect(result.current.selected).toEqual(ALTERNATE_SELECTION);
    expect(result.current.output).toEqual(DEFAULT_SELECTION);
    expect(result.current.pulse).toEqual({
      revision: 1,
      selection: ALTERNATE_SELECTION,
    });
    expect(result.current.announcement).toBe('');

    act(() => result.current.select(ALTERNATE_SELECTION));
    expect(result.current.pulse?.revision).toBe(1);
    expect(vi.getTimerCount()).toBe(1);

    act(() => vi.advanceTimersByTime(PATCH_PULSE_MS - 1));
    expect(result.current.output).toEqual(DEFAULT_SELECTION);

    act(() => vi.advanceTimersByTime(1));
    expect(result.current.output).toEqual(ALTERNATE_SELECTION);
    expect(result.current.pulse).toBeNull();
    expect(result.current.announcement).toBe(pairingAnnouncement(ALTERNATE_SELECTION));
  });

  it('commits synchronously without a pulse when motion is reduced', () => {
    const { result } = renderHook(() => usePairingSelection({ reducedMotion: true }));

    act(() => result.current.select(ALTERNATE_SELECTION));

    expect(result.current.selected).toEqual(ALTERNATE_SELECTION);
    expect(result.current.output).toEqual(ALTERNATE_SELECTION);
    expect(result.current.pulse).toBeNull();
    expect(result.current.announcement).toBe(pairingAnnouncement(ALTERNATE_SELECTION));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels a pending commit and ignores stale pulse revisions', () => {
    const { result } = renderHook(() => usePairingSelection({ reducedMotion: false }));

    act(() => result.current.select(ALTERNATE_SELECTION));
    act(() => vi.advanceTimersByTime(PATCH_PULSE_MS / 2));
    act(() => result.current.select(LATEST_SELECTION));

    expect(result.current.selected).toEqual(LATEST_SELECTION);
    expect(result.current.pulse?.revision).toBe(2);
    expect(vi.getTimerCount()).toBe(1);

    act(() => vi.advanceTimersByTime(PATCH_PULSE_MS / 2));
    expect(result.current.output).toEqual(DEFAULT_SELECTION);

    act(() => vi.advanceTimersByTime(PATCH_PULSE_MS / 2));
    expect(result.current.output).toEqual(LATEST_SELECTION);
    expect(result.current.announcement).toBe(pairingAnnouncement(LATEST_SELECTION));

    const activeState = matrixStateReducer(INITIAL_MATRIX_STATE, {
      type: 'pulse-started',
      revision: 2,
      selection: LATEST_SELECTION,
    });
    expect(matrixStateReducer(activeState, { type: 'pulse-completed', revision: 1 })).toBe(
      activeState,
    );
  });

  it('settles the latest rapid selection when reduced motion turns on mid-pulse', () => {
    const { result, rerender } = renderHook(
      ({ reducedMotion }) => usePairingSelection({ reducedMotion }),
      { initialProps: { reducedMotion: false } },
    );

    act(() => result.current.select(ALTERNATE_SELECTION));
    act(() => vi.advanceTimersByTime(PATCH_PULSE_MS / 4));
    act(() => result.current.select(LATEST_SELECTION));
    act(() => vi.advanceTimersByTime(PATCH_PULSE_MS / 4));

    expect(result.current.selected).toEqual(LATEST_SELECTION);
    expect(result.current.output).toEqual(DEFAULT_SELECTION);
    expect(result.current.pulse?.revision).toBe(2);
    expect(vi.getTimerCount()).toBe(1);

    rerender({ reducedMotion: true });

    expect(result.current.selected).toEqual(LATEST_SELECTION);
    expect(result.current.output).toEqual(LATEST_SELECTION);
    expect(result.current.pulse).toBeNull();
    expect(result.current.announcement).toBe(pairingAnnouncement(LATEST_SELECTION));
    expect(vi.getTimerCount()).toBe(0);

    act(() => vi.advanceTimersByTime(PATCH_PULSE_MS * 2));
    rerender({ reducedMotion: false });

    expect(result.current.output).toEqual(LATEST_SELECTION);
    expect(result.current.pulse).toBeNull();
    expect(result.current.announcement).toBe(pairingAnnouncement(LATEST_SELECTION));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears pending work when its owner unmounts', () => {
    const { result, unmount } = renderHook(() => usePairingSelection({ reducedMotion: false }));

    act(() => result.current.select(ALTERNATE_SELECTION));
    expect(vi.getTimerCount()).toBe(1);

    unmount();

    expect(vi.getTimerCount()).toBe(0);
    expect(() => vi.advanceTimersByTime(PATCH_PULSE_MS)).not.toThrow();
  });

  it('does not replace the focused control while pulse state advances', () => {
    function FocusHarness() {
      const selection = usePairingSelection({ reducedMotion: false });

      return createElement(
        'button',
        {
          type: 'button',
          'data-output': selection.output.plannerId,
          onClick: () => selection.select(ALTERNATE_SELECTION),
        },
        'Seat alternate pair',
      );
    }

    render(createElement(FocusHarness));
    const control = screen.getByRole('button', { name: 'Seat alternate pair' });

    control.focus();
    fireEvent.click(control);
    expect(control).toHaveFocus();

    act(() => vi.advanceTimersByTime(PATCH_PULSE_MS));

    expect(control).toHaveFocus();
    expect(control).toHaveAttribute('data-output', ALTERNATE_SELECTION.plannerId);
  });
});
