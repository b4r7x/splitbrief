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

// React on Node schedules renders and passive effects via setImmediate, and expired
// timers run before the check phase when a starved process wakes, so a timer-based
// tick(ms) can resume the test before Ink's useInput has (re)subscribed and the next
// stdin.write lands on a stale or absent handler. Awaiting setImmediate turns queues
// behind that pending work: turn 1 covers the render+commit, turn 2 the passive-effect
// flush it schedules, turn 3 is margin. Await this before each stdin.write.
export async function flushEffects(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await tick();
  }
}
