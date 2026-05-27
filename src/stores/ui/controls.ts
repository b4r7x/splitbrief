import type { InputMode } from '../../core/navigation/types.js';
import { createStore, storeBase } from '../create-store.js';

interface ControlsState {
  sidebarVisible: boolean;
  inputMode: InputMode;
}

const initial: ControlsState = { sidebarVisible: false, inputMode: 'normal' };

const store = createStore<ControlsState>(initial);

export const controlsStore = {
  ...storeBase(store),
  __testReset: () => store.set(initial),
  toggleSidebar: () => {
    store.set(prev => ({ ...prev, sidebarVisible: !prev.sidebarVisible }));
  },
  setSidebar: (visible: boolean) => {
    store.set(prev => prev.sidebarVisible === visible ? prev : { ...prev, sidebarVisible: visible });
  },
  setInputMode: (mode: InputMode) => {
    store.set(prev => prev.inputMode === mode ? prev : { ...prev, inputMode: mode });
  },
  clearInputMode: () => {
    store.set(prev => prev.inputMode === 'normal' ? prev : { ...prev, inputMode: 'normal' });
  },
};
