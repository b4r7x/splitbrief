import { render } from 'ink-testing-library';
import type { ReactElement } from 'react';

export interface RenderFeatureResult {
  lastFrame: () => string | undefined;
  frames: readonly string[];
  unmount: () => void;
  stdin: { write: (data: string) => void };
  rerender: (element: ReactElement) => void;
}

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

export function tick(ms = 0): Promise<void> {
  if (ms > 0) {
    return new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    });
  }
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}
