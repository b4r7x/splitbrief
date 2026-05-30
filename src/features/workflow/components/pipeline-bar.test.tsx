import { describe, expect, it } from 'vitest';
import { renderFeature, tick } from '#testing/helpers/ink.js';
import { PipelineBar } from './pipeline-bar.js';

const STAGES = ['res', 'spec', 'plan', 'impl', 'rev'];

describe('PipelineBar', () => {
  it('renders every pipeline stage label in order', async () => {
    const ui = renderFeature(<PipelineBar phase="researching" />);
    await tick();
    const frame = ui.lastFrame() ?? '';

    const positions = STAGES.map((stage) => frame.indexOf(stage));
    for (const position of positions) expect(position).toBeGreaterThanOrEqual(0);
    const sorted = [...positions].sort((a, b) => a - b);
    expect(positions).toEqual(sorted);

    ui.unmount();
  });

  it('keeps a visible gap between each step marker and label', async () => {
    const ui = renderFeature(<PipelineBar phase="researching" />);
    await tick();
    const frame = ui.lastFrame() ?? '';

    for (const stage of STAGES) expect(frame).toContain(` ${stage}`);

    ui.unmount();
  });

  it('reflects the active phase in the rendered bar', async () => {
    const research = renderFeature(<PipelineBar phase="researching" />);
    await tick();
    const researchFrame = research.lastFrame() ?? '';
    research.unmount();

    const implement = renderFeature(<PipelineBar phase="implementing" />);
    await tick();
    const implementFrame = implement.lastFrame() ?? '';
    implement.unmount();

    expect(researchFrame).not.toBe(implementFrame);
  });
});
