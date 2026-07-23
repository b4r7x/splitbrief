import { describe, expect, it } from 'vitest';
import type { TerminalHandoverConfig } from '../../../src/lib/terminal/editor-handover.js';
import {
  prepareInlineFallbackAfterFullscreenFailure,
  startFullscreenThenActivateHandover,
} from '../../../src/cli/render/terminal-handover.js';

describe('startFullscreenThenActivateHandover', () => {
  it('marks terminal handover only after fullscreen start succeeds', async () => {
    const calls: string[] = [];
    const handover: TerminalHandoverConfig = {
      fullscreen: true,
      mouse: true,
      hover: true,
      sourceStdin: process.stdin,
    };
    let activeHandover: TerminalHandoverConfig | undefined;

    await startFullscreenThenActivateHandover({
      start: async () => {
        calls.push('start');
      },
      publishFilteredStdin: () => {
        calls.push('publish-filtered-stdin');
      },
      activateFilteredStdin: () => {
        calls.push('activate-filtered-stdin');
      },
      handover,
      setHandover: (config) => {
        activeHandover = config;
        calls.push('handover');
      },
    });

    expect(activeHandover).toBe(handover);
    expect(activeHandover?.hover).toBe(true);
    expect(calls).toEqual([
      'publish-filtered-stdin',
      'start',
      'activate-filtered-stdin',
      'handover',
    ]);
  });

  it('leaves terminal handover inactive when fullscreen start fails', async () => {
    const calls: string[] = [];
    const handover: TerminalHandoverConfig = {
      fullscreen: true,
      mouse: true,
      sourceStdin: process.stdin,
    };
    let activeHandover: TerminalHandoverConfig | undefined;

    await expect(
      startFullscreenThenActivateHandover({
        publishFilteredStdin: () => {
          calls.push('publish-filtered-stdin');
        },
        start: async () => {
          calls.push('start');
          throw new Error('fullscreen unavailable');
        },
        activateFilteredStdin: () => {
          calls.push('activate-filtered-stdin');
        },
        handover,
        setHandover: (config) => {
          activeHandover = config;
          calls.push('handover');
        },
      }),
    ).rejects.toThrow('fullscreen unavailable');

    expect(activeHandover).toBeUndefined();
    expect(calls).toEqual(['publish-filtered-stdin', 'start']);
  });
});

describe('prepareInlineFallbackAfterFullscreenFailure', () => {
  it('clears fullscreen input state before returning normal stdin for fallback', () => {
    const calls: string[] = [];

    const fallbackStdin = prepareInlineFallbackAfterFullscreenFailure({
      sourceStdin: process.stdin,
      clearTerminalHandover: () => calls.push('clear-handover'),
      clearFilteredStdin: () => calls.push('clear-filtered-stdin'),
      disableFilteredStdin: () => calls.push('disable-filtered-stdin'),
    });

    expect(fallbackStdin).toBe(process.stdin);
    expect(calls).toEqual(['clear-handover', 'clear-filtered-stdin', 'disable-filtered-stdin']);
  });
});
