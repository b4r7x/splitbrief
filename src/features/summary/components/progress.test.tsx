import { describe, expect, it } from 'vitest';
import { renderFeature } from '#testing/helpers/ink.js';
import { SummaryProgress } from './progress.js';

describe('SummaryProgress', () => {
  it('renders the completion fraction with local and failed counts and no filled bar', () => {
    const ui = renderFeature(
      <SummaryProgress completed={2} total={4} completedByLocal={1} failed={1} isSmall={false} />,
    );
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('2/4 tasks');
    expect(frame).toContain('1 local');
    expect(frame).toContain('1 failed');
    expect(frame).not.toContain('escalated');
    expect(frame).not.toContain('local = cheap');
    expect(frame).not.toMatch(/[█░▰▱]/);

    ui.unmount();
  });

  it('drops the unit word and the failed clause on small terminals without failures', () => {
    const ui = renderFeature(
      <SummaryProgress completed={6} total={6} completedByLocal={4} failed={0} isSmall={true} />,
    );
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('6/6');
    expect(frame).toContain('4 local');
    expect(frame).not.toContain('tasks');
    expect(frame).not.toContain('failed');

    ui.unmount();
  });

  it('renders a quiet line when no task briefs were compiled', () => {
    const ui = renderFeature(
      <SummaryProgress completed={0} total={0} completedByLocal={0} failed={0} isSmall={false} />,
    );
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('no task briefs compiled');
    expect(frame).not.toContain('0/0');

    ui.unmount();
  });
});
