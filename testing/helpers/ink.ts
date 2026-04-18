import { render } from 'ink-testing-library';
import type { ReactElement } from 'react';

export interface RenderFeatureResult {
  lastFrame: () => string | undefined;
  frames: readonly string[];
  unmount: () => void;
  stdin: { write: (data: string) => void };
  rerender: (element: ReactElement) => void;
}

/**
 * Render a feature-level component for an Ink-based test.
 *
 * Thin wrapper over `ink-testing-library.render()` that exposes the stable
 * surface tests need: `lastFrame()`, `frames`, `unmount()`, `stdin.write()`,
 * `rerender()`. Anything beyond that, call `render()` directly.
 */
export function renderFeature(element: ReactElement): RenderFeatureResult {
  const instance = render(element);
  return {
    lastFrame: instance.lastFrame,
    frames: instance.frames,
    unmount: instance.unmount,
    stdin: instance.stdin,
    rerender: instance.rerender,
  };
}

/**
 * Yield to Ink's render scheduler and microtask queue.
 *
 * Without an argument, waits for one macrotask (`setImmediate`) plus a
 * microtask flush — enough for Ink to paint a new frame after a state change.
 * With a positive `ms`, waits that many milliseconds via `setTimeout`.
 */
export function tick(ms = 0): Promise<void> {
  if (ms > 0) {
    return new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    }).then(() => Promise.resolve());
  }
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  }).then(() => Promise.resolve());
}
