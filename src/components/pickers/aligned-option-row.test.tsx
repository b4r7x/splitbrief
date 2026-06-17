import { Box } from 'ink';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { AlignedOptionRow, getAlignedOptionLabelWidth } from './aligned-option-row.js';

describe('getAlignedOptionLabelWidth', () => {
  it('sizes a label column from the longest visible label plus the configured gap', () => {
    expect(getAlignedOptionLabelWidth(['Help', 'Settings', 'Mode'], { gap: 2 })).toBe(10);
  });

  it('measures sanitized terminal cell width for labels', () => {
    expect(getAlignedOptionLabelWidth(['\u001b[31mGo\u001b[0m', '界e\u0301'], { gap: 2 })).toBe(5);
  });

  it('respects max and min width bounds', () => {
    expect(getAlignedOptionLabelWidth(['VeryLongCommandName'], { gap: 2, maxWidth: 8 })).toBe(8);
    expect(getAlignedOptionLabelWidth([], { gap: 2, minWidth: 4 })).toBe(4);
  });
});

describe('AlignedOptionRow', () => {
  it('removes terminal controls before rendering row text', () => {
    const ui = render(
      <Box width={40}>
        <AlignedOptionRow
          meta={{ text: '\u001b]0;owned\u0007M', width: 2 }}
          label={'A\u001b[31m\nB'}
          labelWidth={6}
          detail={'ok\u0007\u001b[2Kdone'}
        />
      </Box>,
    );

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('AB');
    expect(frame).toContain('okdone');
    expect(frame).not.toContain('owned');
    expect(frame).not.toContain('\u001b');
    expect(frame).not.toContain('\u0007');
    expect(frame.split('\n')).toHaveLength(1);
    ui.unmount();
  });
});
