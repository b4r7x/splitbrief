import { describe, expect, it } from 'vitest';
import { materializeConversationRowsWindow } from './materialize-window.js';
import { rowText } from './row-format/rows.js';
import type { ConversationRowBlock } from './types.js';

describe('materializeConversationRowsWindow', () => {
  it('materializes only blocks that intersect the requested row window', () => {
    const calls: string[] = [];
    const block = (key: string, rowCount: number): ConversationRowBlock => ({
      key,
      rowCount,
      renderableUnits: 1,
      createRows: (windowStart, windowEnd) => {
        calls.push(`${key}:${windowStart}-${windowEnd}`);
        return Array.from({ length: windowEnd - windowStart }, (_, index) => ({
          key: `${key}-${windowStart + index}`,
          kind: 'message',
          segments: [{ text: `${key}-${windowStart + index}` }],
        }));
      },
    });

    const rows = materializeConversationRowsWindow({
      projection: {
        blocks: [block('before', 2), block('visible', 3), block('after', 2)],
        renderableCount: 3,
        totalRows: 7,
      },
      windowStart: 2,
      windowEnd: 4,
    });

    expect(calls).toEqual(['visible:0-2']);
    expect(rows.map(rowText)).toEqual(['visible-0', 'visible-1']);
  });
});
