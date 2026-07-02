import { createStore, storeBase } from '../create-store.js';

export interface QuestionPromptState {
  hint: string | null;
}

const initial: QuestionPromptState = { hint: null };
const store = createStore<QuestionPromptState>(initial);

function setHint(hint: string): void {
  store.set({ hint });
}

function clearHint(): void {
  store.set(initial);
}

export const questionPromptStore = {
  ...storeBase(store),
  setHint,
  clearHint,
};
