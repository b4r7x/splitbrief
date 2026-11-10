import { describe, expect, it } from 'vitest';
import { foldRow } from './fold-row.js';
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
          segments: [{ text: `${key}-${windowStart + index}`, tone: 'text' }],
        }));
      },
    });

    const rows = materializeConversationRowsWindow({
      projection: {
        activeTaskHeaderKey: null,
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

  it('names the activity key on the lowest fold row of the transcript, and on no other', () => {
    const folded = (key: string): ConversationRowBlock => ({
      key,
      rowCount: 1,
      renderableUnits: 0,
      foldRowKey: `${key}-hidden`,
      createRows: () => [
        foldRow({ foldKey: key, expanded: false, hidden: ['+3 earlier'], width: 80 }),
      ],
    });
    const plain = (key: string): ConversationRowBlock => ({
      key,
      rowCount: 1,
      renderableUnits: 1,
      createRows: () => [{ key, kind: 'message', segments: [{ text: key, tone: 'text' }] }],
    });
    const window = (blocks: ConversationRowBlock[], windowStart = 0) =>
      materializeConversationRowsWindow({
        projection: {
          activeTaskHeaderKey: null,
          blocks,
          renderableCount: 2,
          totalRows: blocks.length,
        },
        windowStart,
        windowEnd: blocks.length,
      }).map(rowText);

    expect(window([folded('older'), plain('said'), folded('lowest'), plain('after')])).toEqual([
      '+3 earlier',
      'said',
      '+3 earlier · ctrl+a',
      'after',
    ]);
    // The lowest fold is below the window: no row in the window may claim the key.
    expect(window([folded('older'), plain('said'), folded('lowest')]).slice(0, 2)).toEqual([
      '+3 earlier',
      'said',
    ]);
    expect(window([folded('only')])).toEqual(['+3 earlier · ctrl+a']);
  });
});
