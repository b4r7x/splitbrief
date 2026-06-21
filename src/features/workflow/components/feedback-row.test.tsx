import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderFeature } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { abortStore } from '../../../stores/workflow/abort.js';
import { WORKFLOW_CONTENT_PADDING_X } from '../layout/rect.js';
import { FeedbackRow } from './feedback-row.js';

describe('FeedbackRow', () => {
  beforeEach(() => {
    abortStore.clear();
    resetAllStores();
  });

  afterEach(() => {
    abortStore.clear();
    resetAllStores();
  });

  it('aligns armed interrupt feedback with the workflow content inset', () => {
    abortStore.arm('interrupt');

    const ui = renderFeature(<FeedbackRow />);
    const frame = ui.lastFrame() ?? '';

    expect(frame.indexOf('Esc again to interrupt')).toBe(WORKFLOW_CONTENT_PADDING_X);

    ui.unmount();
  });
});
