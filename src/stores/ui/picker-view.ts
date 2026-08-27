import { createStore, storeBase } from '../create-store.js';
import type { CustomCommandRunnerKind } from '../../core/config/custom-commands.js';

export type PickerSubView =
  | { kind: 'picker' }
  | { kind: 'custom-command-contract'; refocusKind?: CustomCommandRunnerKind | undefined }
  | { kind: 'custom-command'; intendedKind: CustomCommandRunnerKind }
  | { kind: 'custom-model' }
  | { kind: 'provider-auth' };

export interface PickerViewState {
  view: PickerSubView;
  preservedLeftIndex: number;
  expandedModelId: string | null;
  draft: string | null;
}

const initial: PickerViewState = {
  view: { kind: 'picker' },
  preservedLeftIndex: 0,
  expandedModelId: null,
  draft: null,
};

const store = createStore<PickerViewState>(initial);

function open(view: PickerSubView, preservedLeftIndex?: number) {
  store.set((s) => ({
    ...s,
    view,
    preservedLeftIndex: preservedLeftIndex ?? s.preservedLeftIndex,
  }));
}

function close() {
  store.set((s) =>
    s.view.kind === 'picker' && s.draft === null
      ? s
      : { ...s, view: { kind: 'picker' }, draft: null },
  );
}

function expand(modelId: string) {
  store.set((s) => (s.expandedModelId === modelId ? s : { ...s, expandedModelId: modelId }));
}

function collapse() {
  store.set((s) => (s.expandedModelId === null ? s : { ...s, expandedModelId: null }));
}

function setDraft(draft: string) {
  store.set((s) => (s.draft === draft ? s : { ...s, draft }));
}

export const pickerViewStore = {
  ...storeBase(store),
  open,
  close,
  expand,
  collapse,
  setDraft,
};
