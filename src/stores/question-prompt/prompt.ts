import { createStore, storeBase } from '../create-store.js';
import type { ClarificationQuestion } from '../../core/schemas/question.js';

export interface QuestionPromptState {
  hint: string | null;
  questions?: readonly ClarificationQuestion[] | undefined;
}

const initial: QuestionPromptState = { hint: null };
const store = createStore<QuestionPromptState>(initial);

function setHint(hint: string): void {
  store.set({ hint });
}

function setQuestions(questions: readonly ClarificationQuestion[]): void {
  store.set((state) => ({ ...state, questions }));
}

function clearHint(): void {
  store.set(initial);
}

export const questionPromptStore = {
  ...storeBase(store),
  setHint,
  setQuestions,
  clearHint,
};
