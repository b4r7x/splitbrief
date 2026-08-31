import { afterEach, describe, expect, it, vi } from 'vitest';
import { Text } from 'ink';
import { spinnerFrames } from '../lib/glyphs.js';
import { useSpinnerFrame } from './use-spinner-frame.js';
import { renderFeature, tick } from '#testing/helpers/ink.js';

function SpinnerHarness({ active }: { active: boolean }) {
  const { frame } = useSpinnerFrame(active);
  return <Text>{`frame:[${frame}]`}</Text>;
}

function renderedFrame(output: string | undefined): string | undefined {
  return /frame:\[(.*)\]/.exec(output ?? '')?.[1];
}

describe('useSpinnerFrame', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('renders a spinner frame when active', () => {
    const ui = renderFeature(<SpinnerHarness active={true} />);
    expect(spinnerFrames()).toContain(renderedFrame(ui.lastFrame()));
    ui.unmount();
  });

  it('pins to initial frame under reduce-motion', async () => {
    vi.stubEnv('SPLITBRIEF_REDUCE_MOTION', '1');
    const ui = renderFeature(<SpinnerHarness active={true} />);
    const initial = ui.lastFrame();
    await tick(300);
    expect(ui.lastFrame()).toBe(initial);
    ui.unmount();
  });
});
