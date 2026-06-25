import { describe, expect, it, vi } from 'vitest';
import type { ConversationRowsProjection } from './types.js';
import { computeConversationRowsWindowFromProjection } from './scroll.js';

describe('computeConversationRowsWindowFromProjection', () => {
  it('finds the active row from block metadata without materializing off-screen blocks', () => {
    const createActiveRows = vi.fn(() => []);
    const createTailRows = vi.fn(() => []);
    const projection: ConversationRowsProjection = {
      renderableCount: 2,
      totalRows: 50_001,
      blocks: [
        {
          key: 'activity',
          rowCount: 1,
          renderableUnits: 1,
          activeRowKey: 'activity-header',
          createRows: createActiveRows,
        },
        {
          key: 'large-tail',
          rowCount: 50_000,
          renderableUnits: 1,
          createRows: createTailRows,
        },
      ],
    };

    const result = computeConversationRowsWindowFromProjection({
      projection,
      viewportHeight: 10,
      rawScrollOffset: 0,
      renderableCountAtScroll: 0,
      heightAtScroll: 0,
    });

    expect(result.activeRowKey).toBe('activity-header');
    expect(createActiveRows).not.toHaveBeenCalled();
    expect(createTailRows).toHaveBeenCalledTimes(1);
    expect(createTailRows).toHaveBeenCalledWith(49_991, 50_000);
  });
});
