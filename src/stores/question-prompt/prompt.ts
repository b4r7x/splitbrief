import { createStore, storeBase } from '../create-store.js';
import type { ClarificationQuestion } from '../../core/schemas/question.js';

export interface QuestionAnswerDraft {
  text: string;
  selected: number;
}

export interface QuestionPromptState {
  hint: string | null;
  questions?: readonly ClarificationQuestion[] | undefined;
  index: number;
  drafts: readonly QuestionAnswerDraft[];
  answers: readonly string[];
  focus: 'menu' | 'answer' | 'composer';
  openedAt: number;
  complete: boolean;
}

export function questionOptions(question: ClarificationQuestion): readonly string[] {
  const options =
    question.type === 'confirm'
      ? ['Yes', 'No']
      : question.type === 'choice'
        ? question.options
        : [];
  const value =
    typeof question.default === 'boolean' ? (question.default ? 'Yes' : 'No') : question.default;
  const preferred = value === undefined ? -1 : options.indexOf(value);
  return preferred > 0
    ? [
        ...options.slice(preferred, preferred + 1),
        ...options.slice(0, preferred),
        ...options.slice(preferred + 1),
      ]
    : options;
}

function initialDraft(question: ClarificationQuestion): QuestionAnswerDraft {
  const options = questionOptions(question);
  const value =
    typeof question.default === 'boolean' ? (question.default ? 'Yes' : 'No') : question.default;
  return {
    text: options.length === 0 ? (value ?? '') : '',
    selected: 0,
  };
}

const initial: QuestionPromptState = {
  hint: null,
  index: 0,
  drafts: [],
  answers: [],
  focus: 'composer',
  openedAt: 0,
  complete: false,
};
const store = createStore<QuestionPromptState>(initial);

function setHint(hint: string): void {
  store.set({ ...initial, hint });
}

function setQuestions(questions: readonly ClarificationQuestion[]): void {
  store.set((state) => ({
    ...initial,
    hint: state.hint,
    questions,
    drafts: questions.map(initialDraft),
    openedAt: Date.now(),
    focus: questions[0] && questionOptions(questions[0]).length > 0 ? 'menu' : 'answer',
  }));
}

function select(selected: number): void {
  store.set((state) => ({
    ...state,
    drafts: state.drafts.map((draft, index) =>
      index === state.index ? { ...draft, selected } : draft,
    ),
  }));
}

function setFocus(focus: QuestionPromptState['focus'], text?: string): void {
  store.set((state) => ({
    ...state,
    focus,
    drafts: state.drafts.map((draft, index) =>
      index === state.index && text !== undefined ? { ...draft, text } : draft,
    ),
  }));
}

function previous(): void {
  store.set((state) => {
    const index = Math.max(0, state.index - 1);
    const question = state.questions?.[index];
    return {
      ...state,
      index,
      focus: question && questionOptions(question).length > 0 ? 'menu' : 'answer',
    };
  });
}

/** Only the completed batch crosses the existing planner-reply boundary. */
function answer(text: string): string | undefined {
  const state = store.get();
  if (state.complete || !state.questions?.length || text.trim() === '') return undefined;
  const answers = [...state.answers];
  answers[state.index] = text.trim();
  const complete = state.index === state.questions.length - 1;
  const index = complete ? state.index : state.index + 1;
  const next = state.questions[index];
  store.set({
    ...state,
    answers,
    complete,
    index,
    focus: next && questionOptions(next).length > 0 ? 'menu' : 'answer',
  });
  return complete
    ? state.questions
        .map((question, i) => `${i + 1}. ${question.text}\n${answers[i] ?? ''}`)
        .join('\n\n')
    : undefined;
}

export const questionPromptStore = {
  ...storeBase(store),
  setHint,
  setQuestions,
  select,
  setFocus,
  previous,
  answer,
  clearHint: (): void => store.set(initial),
};
