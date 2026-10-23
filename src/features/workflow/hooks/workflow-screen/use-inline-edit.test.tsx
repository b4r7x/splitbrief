import { Text } from 'ink';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushEffects, renderFeature, type RenderFeatureResult } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { externalEditRequestStore } from '../../../../stores/ui/external-edit-request.js';
import { reviewStore } from '../../../../stores/workflow/review.js';
import type { ReviewInputEffects } from '../../review-parser.js';
import { plainAnswer, type UseInputModeResult } from '../use-input-mode.js';
import { useWorkflowInlineEdit } from './use-inline-edit.js';

const REVIEW_FILE = '/tmp/use-inline-edit-tasks.md';
const OTHER_FILE = '/tmp/use-inline-edit-plan.md';

const inputMode: UseInputModeResult = {
  mode: 'review',
  hint: '',
  questionEpoch: 0,
  setReviewMode: async () => ({ approved: false }),
  setQuestionMode: async () => plainAnswer(''),
  resolve: vi.fn(),
  resetMode: () => {},
};

function makeEditor() {
  return vi.fn<ReviewInputEffects['openExternalEditor']>(async () => {});
}

function Host({ open }: { open: ReviewInputEffects['openExternalEditor'] }) {
  useWorkflowInlineEdit({ inputMode, openExternalEditor: open });
  return <Text>host</Text>;
}

describe('useWorkflowInlineEdit external edit requests', () => {
  let ui: RenderFeatureResult | undefined;

  beforeEach(() => {
    resetAllStores();
  });

  afterEach(() => {
    ui?.unmount();
    ui = undefined;
    resetAllStores();
  });

  it('spends the supplied editor once for a request the review owner still holds', async () => {
    const open = makeEditor();
    const token = reviewStore.setReviewFile(REVIEW_FILE);
    ui = renderFeature(<Host open={open} />);
    await flushEffects();

    externalEditRequestStore.request(token, 'opened');
    await flushEffects();

    expect(open.mock.calls).toEqual([[inputMode, 'opened']]);
    expect(externalEditRequestStore.get()).toEqual({ status: 'idle' });
  });

  it('consumes a request whose token lost the review without opening an editor', async () => {
    const open = makeEditor();
    const staleToken = reviewStore.setReviewFile(REVIEW_FILE);
    reviewStore.setReviewFile(OTHER_FILE);
    ui = renderFeature(<Host open={open} />);
    await flushEffects();

    externalEditRequestStore.request(staleToken, 'opened');
    await flushEffects();

    expect(open).not.toHaveBeenCalled();
    expect(externalEditRequestStore.get()).toEqual({ status: 'idle' });
  });

  it('does not reopen the editor when the screen rerenders after the request is consumed', async () => {
    const open = makeEditor();
    const token = reviewStore.setReviewFile(REVIEW_FILE);
    ui = renderFeature(<Host open={open} />);
    await flushEffects();
    externalEditRequestStore.request(token, 'opened');
    await flushEffects();
    expect(open).toHaveBeenCalledTimes(1);

    // A fresh function identity re-runs the effect on every rerender: the consumed request,
    // not the dependency list, is what keeps a second editor from opening.
    const reopened = makeEditor();
    ui.rerender(<Host open={reopened} />);
    await flushEffects();
    ui.rerender(<Host open={reopened} />);
    await flushEffects();

    expect(reopened).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('leaves no listener behind once the screen unmounts', async () => {
    const open = makeEditor();
    ui = renderFeature(<Host open={open} />);
    await flushEffects();
    ui.unmount();
    ui = undefined;
    await flushEffects();

    const token = reviewStore.setReviewFile(REVIEW_FILE);
    externalEditRequestStore.request(token, 'opened');
    await flushEffects();

    expect(open).not.toHaveBeenCalled();
    expect(externalEditRequestStore.get()).toEqual({
      status: 'requested',
      ownerToken: token,
      action: 'open-external',
      baseline: 'opened',
    });
  });

  it('settles the gate with an edit the overlay saved, without opening an editor', async () => {
    const open = makeEditor();
    const token = reviewStore.setReviewFile(REVIEW_FILE);
    ui = renderFeature(<Host open={open} />);
    await flushEffects();

    externalEditRequestStore.requestApply(token);
    await flushEffects();

    expect(inputMode.resolve).toHaveBeenCalledWith({ approved: false, action: 'edit' });
    expect(open).not.toHaveBeenCalled();
    expect(externalEditRequestStore.get()).toEqual({ status: 'idle' });
  });
});
