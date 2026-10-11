import { describe, expect, it } from 'vitest';
import { answeredQuestionsRowBlock } from './answered-questions.js';
import { rowText } from '../row-format/rows.js';

describe('answeredQuestionsRowBlock', () => {
  it('keeps question labels in the planner tone and padding and answers in text', () => {
    const block = answeredQuestionsRowBlock({
      keyPrefix: 'qa',
      qa: [{ question: 'Which check?', answer: 'npm test' }],
      width: 80,
    });
    if (block === null) throw new Error('Missing answered questions block');
    const rows = block.createRows(0, block.rowCount);

    expect(rows.map(rowText)).toEqual([
      'Answered · 1 question',
      '1. Which check?',
      'You → npm test',
    ]);
    expect(rows[1]?.segments).toEqual([
      { text: '1.', tone: 'planner', bold: true },
      { text: ' ', tone: 'text' },
      { text: 'Which check?', tone: 'planner' },
    ]);
    expect(rows[2]?.segments[0]?.tone).toBe('text');
  });
});
