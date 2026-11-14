import { describe, expect, it } from 'vitest';
import type { EngineEventOf } from '../../../../engine/events/types.js';
import { glyph } from '../../../../lib/glyphs.js';
import { rowText } from '../row-format/rows.js';
import type { ConversationRow, ConversationRowBlock } from '../types.js';
import { seatSwitchedRowBlock } from './seat-switched.js';

const event: EngineEventOf<'seat_switched'> = {
  type: 'seat_switched',
  ts: 0,
  phase: 'implementing',
  seat: 'build',
  from: { tool: 'opencode', model: 'deepseek/deepseek-flash' },
  to: { tool: 'opencode', model: 'opencode-go/deepseek-v4.1-flash', variant: 'high' },
  cause: 'runner-usage-limit',
  auto: true,
  configRevision: 'revision',
};

function rows(block: ConversationRowBlock | null): ConversationRow[] {
  return block === null ? [] : block.createRows(0, block.rowCount);
}

describe('seatSwitchedRowBlock', () => {
  it('names both seats, the fallback and the cause on one row when they fit', () => {
    const block = seatSwitchedRowBlock('switch', event, 200, false);

    expect(block?.key).toBe('switch');
    expect(rows(block).map(rowText)).toEqual([
      `BUILD  OpenCode CLI · DeepSeek V4.1 Flash · via deepseek ${glyph('connectorHandoff')} OpenCode CLI · DeepSeek V4.1 Flash · via opencode-go · high · automatic fallback · usage limit`,
    ]);
  });

  it('leaves the cause to the recovery row that already names it', () => {
    const text = rows(seatSwitchedRowBlock('switch', event, 200, true))
      .map(rowText)
      .join('\n');

    expect(text).toContain('automatic fallback');
    expect(text).not.toContain('usage limit');
  });

  it('starts the destination on its own rows when the two seats do not share one', () => {
    const switched = rows(seatSwitchedRowBlock('switch', event, 55, true));

    expect(switched.map((row) => row.key)).toEqual([
      'switch-from-0',
      'switch-from-1',
      'switch-to-0',
      'switch-to-1',
    ]);
    expect(switched.map(rowText)).toEqual([
      'BUILD  OpenCode CLI · DeepSeek V4.1 Flash',
      'via deepseek',
      `${glyph('connectorHandoff')} OpenCode CLI · DeepSeek V4.1 Flash`,
      'via opencode-go · high · automatic fallback',
    ]);
  });
});
