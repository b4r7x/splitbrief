import { afterEach, describe, expect, it } from 'vitest';
import { plainUserMessage, type UserMessageInput } from '../../core/types/user-input.js';
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
  it('reports an incomplete answer batch as a typed error without completing the prompt', () => {
    store.setQuestions(questions);
    Object.assign(store.get(), { index: 2 });
    const state = store.get();
    expect(() => store.answer(plainUserMessage('No'))).toThrowError(
      expect.objectContaining({
        kind: 'question-prompt-missing-answer',
        data: { index: 0 },
        message: 'Missing answer for question 1',
      }),
    );
    expect(store.get()).toBe(state);
  });

  it('keeps answers local until complete, supports edits, and resolves only once', () => {
    store.setQuestions(questions);
    expect(store.get().drafts[0]?.selected).toBe(0);
    expect(store.answer(plainUserMessage('Builder'))).toBeUndefined();
    expect(store.get().focus).toBe('answer');
    expect(store.get().drafts[1]?.text).toBe('src/');
    expect(store.answer(plainUserMessage('   '))).toBeUndefined();
    expect(store.get().index).toBe(1);
    store.setFocus('menu', 'src/auth.ts');
    store.previous();
    store.select(0);
    expect(store.answer(plainUserMessage('Planner'))).toBeUndefined();
    expect(store.get().drafts[1]?.text).toBe('src/auth.ts');
    expect(store.answer(plainUserMessage('src/auth.ts'))).toBeUndefined();
    expect(store.get().drafts[2]?.selected).toBe(0);
    expect(store.answer(plainUserMessage('No'))).toEqual({
      message: plainUserMessage(
        '1. Which seat?\nPlanner\n\n2. Which files?\nsrc/auth.ts\n\n3. Proceed?\nNo',
      ),
      qa: [
        { question: 'Which seat?', answer: 'Planner' },
        { question: 'Which files?', answer: 'src/auth.ts' },
        { question: 'Proceed?', answer: 'No' },
      ],
    });
    expect(store.answer(plainUserMessage('Yes'))).toBeUndefined();
  });

  it('answers every question with its declared default when each one takes a bare ⏎', () => {
    store.setQuestions(questions);
    let batch: ReturnType<typeof store.answer>;
    for (const question of questions) {
      const { drafts, index } = store.get();
      const draft = drafts[index];
      const options = questionOptions(question);
      batch = store.answer(
        plainUserMessage(
          options.length > 0 ? (options[draft?.selected ?? 0] ?? '') : (draft?.text ?? ''),
        ),
      );
    }
    expect(batch?.qa.map((pair) => pair.answer)).toEqual(['Builder', 'src/', 'No']);
  });

  it('hands the completed batch over once and clears it when the next prompt opens', () => {
    store.setQuestions(questions);
    for (const answer of ['Planner', 'src/auth.ts', 'No']) store.answer(plainUserMessage(answer));
    const batch = store.takeAnswerBatch();
    expect(batch?.message.text).toBe(
      '1. Which seat?\nPlanner\n\n2. Which files?\nsrc/auth.ts\n\n3. Proceed?\nNo',
    );
    expect(batch?.qa).toEqual([
      { question: 'Which seat?', answer: 'Planner' },
      { question: 'Which files?', answer: 'src/auth.ts' },
      { question: 'Proceed?', answer: 'No' },
    ]);
    expect(store.takeAnswerBatch()).toBeUndefined();
    store.setQuestions(questions);
    store.answer(plainUserMessage('Planner'));
    store.setHint('Which database?');
    expect(store.takeAnswerBatch()).toBeUndefined();
  });

  it('discards drafts and answers on cancellation or replacement with reused IDs', () => {
    store.setQuestions(questions);
    store.setFocus('composer', 'unsent');
    store.answer(plainUserMessage('Planner'));
    store.setQuestions(questions);
    expect(store.get()).toMatchObject({ index: 0, answers: [], complete: false });
    expect(store.get().drafts[0]?.text).toBe('');
    store.clearHint();
    expect(store.get().questions).toBeUndefined();
    expect(store.answer(plainUserMessage('late answer'))).toBeUndefined();
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

it('keeps per-answer bodies and metadata in an exact one-shot batch', () => {
  store.setQuestions(questions.slice(0, 2));
  const image = {
    id: 'att-a',
    kind: 'image' as const,
    path: '/outside/a.png',
    mimeType: 'image/png' as const,
    sizeBytes: 4,
  };
  const first: UserMessageInput = {
    text: 'Planner @/outside/a.txt\n\n--- @/outside/a.txt ---\nbody A',
    displayText: 'Planner @/outside/a.txt',
    images: [image],
    attachedInputs: [{ kind: 'text', path: '/outside/a.txt' }],
  };
  const second: UserMessageInput = {
    text: 'src/ @/outside/b.txt\n\n--- @/outside/b.txt ---\nbody B',
    displayText: 'src/ @/outside/b.txt',
    images: [],
    attachedInputs: [{ kind: 'text', path: '/outside/b.txt' }],
  };
  expect(store.answer(first)).toBeUndefined();
  expect(store.get().answers).toEqual([first]);
  const expected = {
    message: {
      text: `1. Which seat?\n${first.text}\n\n2. Which files?\n${second.text}`,
      displayText: `1. Which seat?\n${first.displayText}\n\n2. Which files?\n${second.displayText}`,
      images: [image],
      attachedInputs: [...first.attachedInputs, ...second.attachedInputs],
    },
    qa: [
      { question: 'Which seat?', answer: first.displayText },
      { question: 'Which files?', answer: second.displayText },
    ],
  };
  expect(store.answer(second)).toEqual(expected);
  store.clearHint();
  expect(store.takeAnswerBatch()).toEqual(expected);
  expect(store.takeAnswerBatch()).toBeUndefined();
});
