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
  optionDraftId: string | null;
  draft: string | null;
}

const initial: PickerViewState = {
  view: { kind: 'picker' },
  preservedLeftIndex: 0,
  expandedModelId: null,
  optionDraftId: null,
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

function expand(modelId: string, optionDraftId?: string) {
  store.set((s) => {
    const nextDraft = optionDraftId === undefined ? s.optionDraftId : optionDraftId;
    if (s.expandedModelId === modelId && s.optionDraftId === nextDraft) return s;
    return { ...s, expandedModelId: modelId, optionDraftId: nextDraft };
  });
}

function collapse() {
  store.set((s) =>
    s.expandedModelId === null && s.optionDraftId === null
      ? s
      : { ...s, expandedModelId: null, optionDraftId: null },
  );
}

function setOptionDraftId(optionDraftId: string) {
  store.set((s) => (s.optionDraftId === optionDraftId ? s : { ...s, optionDraftId }));
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
  setOptionDraftId,
  setDraft,
};
