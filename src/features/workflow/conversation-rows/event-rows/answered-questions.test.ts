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

  it('keeps a word on the first row of an answer line that starts with a space', () => {
    const block = answeredQuestionsRowBlock({
      keyPrefix: 'qa',
      qa: [{ question: 'Which brief?', answer: 'Use T004\n configuration ok' }],
      width: 22,
    });
    if (block === null) throw new Error('Missing answered questions block');
    const rows = block.createRows(0, block.rowCount);

    expect(rows.map(rowText)).toEqual([
      'Answered · 1 question',
      '1. Which brief?',
      'You → Use T004',
      ' configuration ',
      'ok',
    ]);
  });

  it.each<[number, string, string[]]>([
    [
      19,
      'Use T004\n configuration ok',
      ['Answered · 1 question', '1. Which brief?', 'You → Use ', 'T004', 'configuration', 'ok'],
    ],
    [
      70,
      `Pin it\n ${'a'.repeat(64)} now`,
      ['Answered · 1 question', '1. Which brief?', 'You → Pin it', 'a'.repeat(64), 'now'],
    ],
  ])(
    'paints no blank row when a later answer line starts with a space and its first word fills the row at width %i',
    (width, answer, expected) => {
      const block = answeredQuestionsRowBlock({
        keyPrefix: 'qa',
        qa: [{ question: 'Which brief?', answer }],
        width,
      });
      if (block === null) throw new Error('Missing answered questions block');
      const rows = block.createRows(0, block.rowCount);

      expect(rows.map(rowText)).toEqual(expected);
    },
  );

  it('keeps a blank line that the user typed between two answer lines', () => {
    const block = answeredQuestionsRowBlock({
      keyPrefix: 'qa',
      qa: [{ question: 'Which brief?', answer: 'first\n\nsecond' }],
      width: 80,
    });
    if (block === null) throw new Error('Missing answered questions block');
    const rows = block.createRows(0, block.rowCount);

    expect(rows.map(rowText)).toEqual([
      'Answered · 1 question',
      '1. Which brief?',
      'You → first',
      '',
      'second',
    ]);
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

  it('paints no blank row when a later reply line starts with a space and its first word fills the row', () => {
    const block = repliedQuestionsRowBlock({
      keyPrefix: 'replied',
      questions: [{ id: 'keep', type: 'confirm', text: 'Keep it?' }],
      reply: 'Use T004\n configuration ok',
      width: 18,
    });
    if (block === null) throw new Error('Missing replied questions block');
    const rows = block.createRows(0, block.rowCount);

    expect(rows.map(rowText)).toEqual([
      'Answered · 1 question',
      '· Keep it?',
      'You → Use ',
      'T004',
      'configuration',
      'ok',
    ]);
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
