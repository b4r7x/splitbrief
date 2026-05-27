import { describe, expect, it } from 'vitest';
import { renderFeature, tick } from '#testing/helpers/ink.js';
import { PipelineBar } from './pipeline-bar.js';

describe('PipelineBar', () => {
  it('keeps a visible gap between each step marker and label', async () => {
    const ui = renderFeature(<PipelineBar phase="researching" />);
    await tick();
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('◉ res');
    expect(frame).toContain('○ spec');
    expect(frame).not.toContain('◉res');
    expect(frame).toBe('◉ res ○ spec ○ plan ○ impl ○ rev');

    ui.unmount();
  });
});
