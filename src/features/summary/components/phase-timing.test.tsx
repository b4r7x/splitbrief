import { describe, expect, it } from 'vitest';
import { Box } from 'ink';
import { renderFeature } from '#testing/helpers/ink.js';
import { useTheme } from '../../../components/theme.js';
import { buildPhaseTimingRows } from './phase-timing.js';

function PhaseTimingRows({ phaseTimings }: { phaseTimings: Record<string, number> }) {
  const theme = useTheme();
  const rows = buildPhaseTimingRows(phaseTimings, 16, theme);
  return (
    <Box flexDirection="column">
      {rows.map((row) => (
        <Box key={row.key}>{row.node}</Box>
      ))}
    </Box>
  );
}

describe('buildPhaseTimingRows', () => {
  it('capitalizes phase labels in the rendered breakdown', () => {
    const ui = renderFeature(
      <PhaseTimingRows phaseTimings={{ planning: 1200, implementing: 3400 }} />,
    );
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('phase breakdown');
    expect(frame).toContain('Planning');
    expect(frame).toContain('Implementing');
    expect(frame).not.toContain('planning');
    expect(frame).not.toContain('implementing');

    ui.unmount();
  });

  it('renders nothing when there are no phase timings', () => {
    const ui = renderFeature(<PhaseTimingRows phaseTimings={{}} />);

    expect(ui.lastFrame()).toBe('');

    ui.unmount();
  });

  it('phase rows render Title Case labels', () => {
    const ui = renderFeature(
      <PhaseTimingRows phaseTimings={{ 'reviewing-spec': 500, review: 1200 }} />,
    );
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('Reviewing Spec');
    expect(frame).toContain('Review');
    expect(frame).not.toContain('reviewing-spec');

    ui.unmount();
  });
});
