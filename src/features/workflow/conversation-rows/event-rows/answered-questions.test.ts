import { describe, expect, it } from 'vitest';
import {
  answeredQuestionsRowBlock,
  repliedQuestionsRowBlock,
  unansweredQuestionsRowBlock,
} from './answered-questions.js';
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

describe('repliedQuestionsRowBlock', () => {
  it('lists the questions in the planner tone under one marked header and the reply once in text', () => {
    const block = repliedQuestionsRowBlock({
      keyPrefix: 'replied',
      questions: [
        {
          id: 'module',
          type: 'choice',
          text: 'Which module should change?',
          options: ['src/auth.ts', 'src/session.ts'],
        },
        { id: 'api', type: 'confirm', text: 'Keep the public API?' },
      ],
      reply: 'Change src/session.ts.',
      width: 80,
    });
    if (block === null) throw new Error('Missing replied questions block');
    const rows = block.createRows(0, block.rowCount);

    expect(rows.map(rowText)).toEqual([
      'Answered · 2 questions',
      '· Which module should change?',
      '· Keep the public API?',
      'You → Change src/session.ts.',
    ]);
    expect(rows.map((row) => row.kind)).toEqual(['prompt', 'message', 'message', 'message']);
    expect(rows[0]?.segments.map((segment) => segment.tone)).toEqual(['textDim', 'planner']);
    expect(rows[1]?.segments[0]?.tone).toBe('planner');
    expect(rows[3]?.segments[0]?.tone).toBe('text');
  });
});

describe('unansweredQuestionsRowBlock', () => {
  it('lists each question with its options under an unmarked header and hangs a wrapped line under its text', () => {
    const block = unansweredQuestionsRowBlock({
      keyPrefix: 'round',
      questions: [
        {
          id: 'module',
          type: 'choice',
          text: 'Which module should change first?',
          options: ['src/auth.ts', 'src/session.ts'],
        },
        { id: 'api', type: 'confirm', text: 'Keep the public API?' },
      ],
      width: 40,
    });
    if (block === null) throw new Error('Missing question round block');
    const rows = block.createRows(0, block.rowCount);

    expect(rows.map(rowText)).toEqual([
      'Unanswered · 2 questions',
      '· Which module should change first?',
      '  (src/auth.ts / src/session.ts)',
      '· Keep the public API? (yes / no)',
    ]);
    expect(rows[0]?.kind).toBe('message');
    expect(rows[0]?.segments.map((segment) => segment.tone)).toEqual(['textDim', 'planner']);
    expect(rows.slice(1).every((row) => row.segments[0]?.tone === 'textDim')).toBe(true);
    expect(unansweredQuestionsRowBlock({ keyPrefix: 'none', questions: [], width: 40 })).toBeNull();
  });
});
