import { createStore, storeBase } from '../create-store.js';

// What the editor overlay asks of the review prompt it cannot reach: open the external editor, or
// settle the gate with an edit the overlay saved.
type EditRequestAction = 'open-external' | 'apply-edit';

type ExternalEditRequest =
  | { status: 'idle' }
  | {
      status: 'requested';
      ownerToken: number;
      action: EditRequestAction;
      /** The text the overlay opened with, which the external edit is compared against. */
      baseline?: string;
    };

const store = createStore<ExternalEditRequest>({ status: 'idle' });

export const externalEditRequestStore = {
  ...storeBase(store),
  request: (ownerToken: number, baseline: string) =>
    store.set({ status: 'requested', ownerToken, action: 'open-external', baseline }),
  requestApply: (ownerToken: number) =>
    store.set({ status: 'requested', ownerToken, action: 'apply-edit' }),
  consume: () => store.set({ status: 'idle' }),
};
