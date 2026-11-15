import { describe, expect, it } from 'vitest';
import type { ClarificationQuestion } from '../../../core/schemas/question.js';
import { fitQuestionText, fitQuestionView, followQuestionSelection } from './question.js';

const choice: ClarificationQuestion = {
  id: 'layout',
  type: 'choice',
  text: 'Which layout?',
  options: ['Grid', 'List'],
};
const input: ClarificationQuestion = { id: 'name', type: 'input', text: 'Which name?' };
const box = { index: 0, selected: 0, width: 40, writing: false, offset: 0 };

describe('fitQuestionView', () => {
  it('gives a tall box the frame, the title, the legend and a scrolling body', () => {
    const view = fitQuestionView({ ...box, question: choice, selected: 1, height: 10 });
    expect(view.innerWidth).toBe(36);
    expect(view.rows.map((row) => row.text)).toEqual([
      'Which layout?',
      '',
      'Grid',
      'List',
      'Write your own answer…',
      'Decide for me',
    ]);
    expect(view).toMatchObject({
      chrome: { framed: true, titled: true, legend: true, listRows: 1, extraRows: 5 },
      showAnswer: false,
      answerRows: 0,
      bodyHeight: 5,
      maxOffset: 1,
      visibleOffset: 0,
      first: 3,
      last: 3,
    });
  });

  it('keeps a stored offset inside the rows the body can scroll', () => {
    const short = { ...box, question: choice, height: 4 };
    expect(fitQuestionView({ ...short, offset: 99 })).toMatchObject({
      bodyHeight: 1,
      maxOffset: 5,
      visibleOffset: 5,
    });
    expect(fitQuestionView({ ...short, offset: -3 }).visibleOffset).toBe(0);
  });

  it('shows the answer field of a question with no options only in a box taller than it', () => {
    expect(fitQuestionView({ ...box, question: input, height: 2 })).toMatchObject({
      showAnswer: false,
      answerRows: 0,
    });
    expect(fitQuestionView({ ...box, question: input, height: 3 })).toMatchObject({
      showAnswer: true,
      answerRows: 2,
      bodyHeight: 1,
    });
  });

  it('keeps a question row above the answer field while the answer is written', () => {
    expect(fitQuestionView({ ...box, question: choice, height: 2, writing: true })).toMatchObject({
      showAnswer: true,
      answerRows: 1,
      bodyHeight: 1,
    });
  });

  it('fits no rows when the question is missing', () => {
    expect(fitQuestionView({ ...box, question: undefined, height: 10 })).toMatchObject({
      rows: [],
      maxOffset: 0,
      visibleOffset: 0,
      first: -1,
      last: -1,
    });
  });
});

describe('followQuestionSelection', () => {
  const view = { first: 3, last: 3, bodyHeight: 5, maxOffset: 1, writing: false };

  it('shows the question from its first row while the answer is written', () => {
    expect(followQuestionSelection(1, { ...view, writing: true })).toBe(0);
  });

  it('scrolls up to the first row of an option above the body', () => {
    expect(followQuestionSelection(4, { ...view, maxOffset: 8 })).toBe(3);
  });

  it('scrolls down until the last row of an option below the body shows', () => {
    expect(
      followQuestionSelection(0, {
        first: 6,
        last: 7,
        bodyHeight: 3,
        maxOffset: 9,
        writing: false,
      }),
    ).toBe(5);
  });

  it('starts an option taller than the body at its first row, inside the scroll range', () => {
    expect(
      followQuestionSelection(0, {
        first: 4,
        last: 7,
        bodyHeight: 2,
        maxOffset: 9,
        writing: false,
      }),
    ).toBe(4);
    expect(
      followQuestionSelection(0, {
        first: 8,
        last: 9,
        bodyHeight: 1,
        maxOffset: 5,
        writing: false,
      }),
    ).toBe(5);
  });

  it('keeps an offset that shows the option, inside the scroll range', () => {
    expect(followQuestionSelection(1, view)).toBe(1);
    expect(followQuestionSelection(2, view)).toBe(1);
  });
});

describe('fitQuestionText', () => {
  const texts = (body: readonly { text: string }[]) => body.map((line) => line.text);

  it('keeps each body row whole and the mark off the rows in a titled box', () => {
    const text = fitQuestionText(fitQuestionView({ ...box, question: choice, height: 10 }), '');
    expect(text).toMatchObject({ mark: '↓ more', asked: '', answerWidth: 34, besideQuestion: '' });
    expect(texts(text.body)).toEqual([
      'Which layout?',
      '',
      'Grid',
      'List',
      'Write your own answer…',
    ]);
  });

  it('puts the mark beside the question at the top of a one-row panel', () => {
    const text = fitQuestionText(fitQuestionView({ ...box, question: choice, height: 1 }), '');
    expect(text).toMatchObject({ mark: '↓ more', asked: ' · ↓ more', besideQuestion: '' });
    expect(texts(text.body)).toEqual(['Which layout?']);
  });

  it('leaves half of a one-row panel to the question beside a long option', () => {
    const long: ClarificationQuestion = {
      id: 'seat',
      type: 'choice',
      text: 'Which seat?',
      options: [`Option ${'x'.repeat(50)}`],
    };
    const view = fitQuestionView({ ...box, question: long, width: 80, height: 1, offset: 2 });
    const text = fitQuestionText(view, '');
    expect(text).toMatchObject({
      mark: '↑ more · ↓ more',
      asked: ' · ↑ more · ↓ more · Which seat?',
    });
    expect(texts(text.body)).toEqual([`Option ${'x'.repeat(30)}…`]);
  });

  it('puts the answer field beside the question in a panel with no body', () => {
    const view = fitQuestionView({ ...box, question: input, height: 1, writing: true });
    expect(view.bodyHeight).toBe(0);
    expect(fitQuestionText(view, 'Ada')).toMatchObject({
      body: [],
      answerWidth: 4,
      besideQuestion: ' · ↓ more · Which name?',
    });
    expect(fitQuestionText(view, 'x'.repeat(30))).toMatchObject({
      answerWidth: 18,
      besideQuestion: ' · ↓ more · Whi…',
    });
  });
});
