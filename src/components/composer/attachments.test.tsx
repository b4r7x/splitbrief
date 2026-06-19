import { describe, expect, it } from 'vitest';
import { getTerminalCellWidth } from '../../utils/display-text.js';
import { attachmentChipLabel } from './attachments.js';

describe('attachmentChipLabel', () => {
  it('fits CJK and emoji file names by terminal cell width', () => {
    const label = attachmentChipLabel('/tmp/界語🙂界語🙂界語🙂界語🙂界語🙂.png', 0);

    expect(label).toContain('📎 1:');
    expect(getTerminalCellWidth(label)).toBeLessThanOrEqual(32);
  });
});
