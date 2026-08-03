import { Text } from 'ink';
import { afterEach, describe, expect, it } from 'vitest';
import { flushEffects, renderFeature, tick } from '#testing/helpers/ink.js';
import { editorStore } from '../../stores/ui/editor.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { approvalPromptStore } from '../../stores/approval-prompt/prompt.js';
import { costApprovalStore } from '../../stores/cost-approval/prompt.js';
import { reviewStore } from '../../stores/workflow/review.js';
import { useEditorKeys } from './use-editor-keys.js';

const LAYOUT = { columns: 40, rows: 6 };

function FieldHost() {
  useEditorKeys({ surface: 'field' });
  return <Text>host</Text>;
}

function openFieldSession() {
  const token = reviewStore.setReviewFile('/tmp/TASKS.md');
  editorStore.openField({
    filePath: '/tmp/TASKS.md',
    value: '',
    ownerToken: token,
    layout: LAYOUT,
  });
}

describe('useEditorKeys field surface stands down under overlays/prompts', () => {
  let unmount: (() => void) | undefined;

  afterEach(() => {
    unmount?.();
    unmount = undefined;
    editorStore.close();
    overlayStore.close();
    approvalPromptStore.__testReset();
    costApprovalStore.__testReset();
    reviewStore.clearReview();
  });

  it('captures keystrokes into the owned field buffer', async () => {
    openFieldSession();
    const ui = renderFeature(<FieldHost />);
    unmount = ui.unmount;
    await flushEffects();

    ui.stdin.write('a');
    await tick();

    const state = editorStore.get();
    expect(state.status === 'open' && state.value).toBe('a');
  });

  it('ignores keystrokes while an overlay covers the field editor', async () => {
    openFieldSession();
    overlayStore.open('command-palette');
    const ui = renderFeature(<FieldHost />);
    unmount = ui.unmount;
    await flushEffects();

    ui.stdin.write('a');
    await tick();

    const state = editorStore.get();
    expect(state.status === 'open' && state.value).toBe('');
  });

  it('ignores keystrokes while an approval prompt is pending', async () => {
    openFieldSession();
    approvalPromptStore.__testReset({
      status: 'pending',
      // The shape is not read by the key gate; only status === 'pending' matters here.
      request: {} as never,
      resolve: () => {},
    });
    const ui = renderFeature(<FieldHost />);
    unmount = ui.unmount;
    await flushEffects();

    ui.stdin.write('a');
    await tick();

    const state = editorStore.get();
    expect(state.status === 'open' && state.value).toBe('');
  });

  it('ignores keystrokes while a cost prompt is pending', async () => {
    openFieldSession();
    costApprovalStore.__testReset({
      status: 'pending',
      prediction: {} as never,
      resolve: () => {},
    });
    const ui = renderFeature(<FieldHost />);
    unmount = ui.unmount;
    await flushEffects();

    ui.stdin.write('a');
    await tick();

    const state = editorStore.get();
    expect(state.status === 'open' && state.value).toBe('');
  });
});
