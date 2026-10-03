import { afterEach, describe, expect, it } from 'vitest';
import type { ClarificationQuestion } from '../../core/schemas/question.js';
import { questionOptions, questionPromptStore as store } from './prompt.js';

const questions: ClarificationQuestion[] = [
  {
    id: 'seat',
    type: 'choice',
    text: 'Which seat?',
    options: ['Planner', 'Builder'],
    default: 'Builder',
  },
  { id: 'scope', type: 'input', text: 'Which files?', default: 'src/' },
  { id: 'ready', type: 'confirm', text: 'Proceed?', default: false },
];

afterEach(() => store.reset());

describe('planner question batch', () => {
  it('keeps answers local until complete, supports edits, and resolves only once', () => {
    store.setQuestions(questions);
    expect(store.get().drafts[0]?.selected).toBe(0);
    expect(store.answer('Builder')).toBeUndefined();
    expect(store.get().focus).toBe('answer');
    expect(store.get().drafts[1]?.text).toBe('src/');
    expect(store.answer('   ')).toBeUndefined();
    expect(store.get().index).toBe(1);
    store.setFocus('menu', 'src/auth.ts');
    store.previous();
    store.select(0);
    expect(store.answer('Planner')).toBeUndefined();
    expect(store.get().drafts[1]?.text).toBe('src/auth.ts');
    expect(store.answer('src/auth.ts')).toBeUndefined();
    expect(store.get().drafts[2]?.selected).toBe(0);
    expect(store.answer('No')).toEqual({
      text: '1. Which seat?\nPlanner\n\n2. Which files?\nsrc/auth.ts\n\n3. Proceed?\nNo',
      qa: [
        { question: 'Which seat?', answer: 'Planner' },
        { question: 'Which files?', answer: 'src/auth.ts' },
        { question: 'Proceed?', answer: 'No' },
      ],
    });
    expect(store.answer('Yes')).toBeUndefined();
  });

  it('answers every question with its declared default when each one takes a bare ⏎', () => {
    store.setQuestions(questions);
    let batch: ReturnType<typeof store.answer>;
    for (const question of questions) {
      const { drafts, index } = store.get();
      const draft = drafts[index];
      const options = questionOptions(question);
      batch = store.answer(
        options.length > 0 ? (options[draft?.selected ?? 0] ?? '') : (draft?.text ?? ''),
      );
    }
    expect(batch?.qa.map((pair) => pair.answer)).toEqual(['Builder', 'src/', 'No']);
  });

  it('hands the completed batch over once and clears it when the next prompt opens', () => {
    store.setQuestions(questions);
    for (const answer of ['Planner', 'src/auth.ts', 'No']) store.answer(answer);
    const batch = store.takeAnswerBatch();
    expect(batch?.text).toBe(
      '1. Which seat?\nPlanner\n\n2. Which files?\nsrc/auth.ts\n\n3. Proceed?\nNo',
    );
    expect(batch?.qa).toEqual([
      { question: 'Which seat?', answer: 'Planner' },
      { question: 'Which files?', answer: 'src/auth.ts' },
      { question: 'Proceed?', answer: 'No' },
    ]);
    expect(store.takeAnswerBatch()).toBeUndefined();
    store.setQuestions(questions);
    store.answer('Planner');
    store.setHint('Which database?');
    expect(store.takeAnswerBatch()).toBeUndefined();
  });

  it('discards drafts and answers on cancellation or replacement with reused IDs', () => {
    store.setQuestions(questions);
    store.setFocus('composer', 'unsent');
    store.answer('Planner');
    store.setQuestions(questions);
    expect(store.get()).toMatchObject({ index: 0, answers: [], complete: false });
    expect(store.get().drafts[0]?.text).toBe('');
    store.clearHint();
    expect(store.get().questions).toBeUndefined();
    expect(store.answer('late answer')).toBeUndefined();
  });

  it('falls back to text for empty options and ignores unavailable defaults', () => {
    store.setQuestions([
      { id: 'empty', type: 'choice', text: 'Pick', options: [], default: 'Suggested' },
    ]);
    expect(store.get().focus).toBe('answer');
    expect(store.get().drafts[0]?.text).toBe('Suggested');
    store.setQuestions([
      { id: 'empty', type: 'choice', text: 'Pick', options: ['A', 'B'], default: 'Missing' },
    ]);
    expect(store.get().drafts[0]).toEqual({ text: '', selected: 0 });
  });
});

it('stores and clears the generic hint, resetting any structured batch', () => {
  expect(store.get().hint).toBeNull();
  store.setQuestions(questions);
  store.setHint('Which database?');
  expect(store.get().hint).toBe('Which database?');
  expect(store.get().questions).toBeUndefined();
  store.clearHint();
  expect(store.get().hint).toBeNull();
});

it('puts the default first, preserves other choices and never mutates the source', () => {
  const question: ClarificationQuestion = {
    id: 'goal',
    type: 'choice',
    text: 'Goal?',
    options: ['Simplify', 'Fix a bug', 'Cleanup'],
    default: 'Cleanup',
  };
  expect(questionOptions(question)).toEqual(['Cleanup', 'Simplify', 'Fix a bug']);
  expect(question.options).toEqual(['Simplify', 'Fix a bug', 'Cleanup']);
  expect(
    questionOptions({ id: 'confirm', type: 'confirm', text: 'Continue?', default: false }),
  ).toEqual(['No', 'Yes']);
});
