import { createStore, storeBase } from './create-store.js';

export interface InputModeState {
  interactive: boolean;
}

const initial: InputModeState = {
  interactive: false,
};

const store = createStore<InputModeState>(initial);

function setInteractive(active: boolean) {
  store.set(s => s.interactive === active ? s : { ...s, interactive: active });
}

export const inputModeStore = {
  ...storeBase(store),
  setInteractive,
};
