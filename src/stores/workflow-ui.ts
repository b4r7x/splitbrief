import { createStore, storeBase } from './create-store.js';

interface WorkflowUIState {
  sidebarVisible: boolean;
}

const initial: WorkflowUIState = { sidebarVisible: false };

const store = createStore<WorkflowUIState>(initial);

function toggleSidebar() {
  store.set(s => ({ ...s, sidebarVisible: !s.sidebarVisible }));
}

export const workflowUIStore = {
  ...storeBase(store),
  toggleSidebar,
};
