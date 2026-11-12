import { createStore, storeBase } from '../create-store.js';
import type { CustomCommandRunnerKind } from '../../core/config/custom-commands.js';
import type { ApiProviderId } from '../../core/providers/api-provider-catalog.js';

export type PickerSubView =
  | { kind: 'picker' }
  | { kind: 'custom-command-contract'; refocusKind?: CustomCommandRunnerKind | undefined }
  | { kind: 'custom-command'; intendedKind: CustomCommandRunnerKind }
  | { kind: 'custom-model' }
  /** The local server's own address, token and catalog; the seat is the picker's. */
  | { kind: 'local-connection'; provider: ApiProviderId };

export interface PickerViewState {
  view: PickerSubView;
  preservedLeftIndex: number;
  expandedModelId: string | null;
  optionDraftId: string | null;
  /** The drafted axis value, whichever field the seat's channel will store it in. */
  effortDraft: string | null;
  draft: string | null;
  browseCatalog: boolean;
  /** Set when the picker takes a row: it saved the seat and closes. Escape and Ctrl+D never set it. */
  committed: boolean;
}

const initial: PickerViewState = {
  view: { kind: 'picker' },
  preservedLeftIndex: 0,
  expandedModelId: null,
  optionDraftId: null,
  effortDraft: null,
  draft: null,
  browseCatalog: false,
  committed: false,
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

function expand(modelId: string, optionDraftId?: string, effortDraft?: string | null) {
  store.set((s) => {
    const nextDraft = optionDraftId === undefined ? s.optionDraftId : optionDraftId;
    const nextEffort = effortDraft === undefined ? s.effortDraft : effortDraft;
    if (
      s.expandedModelId === modelId &&
      s.optionDraftId === nextDraft &&
      s.effortDraft === nextEffort
    ) {
      return s;
    }
    return { ...s, expandedModelId: modelId, optionDraftId: nextDraft, effortDraft: nextEffort };
  });
}

function collapse() {
  store.set((s) =>
    s.expandedModelId === null && s.optionDraftId === null && s.effortDraft === null
      ? s
      : { ...s, expandedModelId: null, optionDraftId: null, effortDraft: null },
  );
}

function setOptionDraftId(optionDraftId: string) {
  store.set((s) => (s.optionDraftId === optionDraftId ? s : { ...s, optionDraftId }));
}

function setEffortDraft(effortDraft: string | null) {
  store.set((s) => (s.effortDraft === effortDraft ? s : { ...s, effortDraft }));
}

function setDraft(draft: string) {
  store.set((s) => (s.draft === draft ? s : { ...s, draft }));
}

function setBrowseCatalog(browseCatalog: boolean) {
  store.set((s) => (s.browseCatalog === browseCatalog ? s : { ...s, browseCatalog }));
}

function setCommitted(committed: boolean) {
  store.set((s) => (s.committed === committed ? s : { ...s, committed }));
}

export const pickerViewStore = {
  ...storeBase(store),
  open,
  close,
  expand,
  collapse,
  setOptionDraftId,
  setEffortDraft,
  setDraft,
  setBrowseCatalog,
  setCommitted,
};
