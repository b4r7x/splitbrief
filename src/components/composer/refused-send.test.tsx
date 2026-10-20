import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeRunRecord } from '#testing/helpers/factories/run-record.js';
import { renderThroughFilteredStdin } from '#testing/helpers/filtered-stdin-harness.js';
import { flushEffects } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { createDraftDocument } from '../../core/composer/document.js';
import { readSessionDraft } from '../../core/sessions/draft.js';
import type { QueueSubmissionResult } from '../../engine/orchestrator/types.js';
import type { UseInputModeResult } from '../../features/workflow/hooks/use-input-mode.js';
import { createReviewInputHandler } from '../../features/workflow/review-parser.js';
import { routerStore } from '../../stores/navigation/router.js';
import { composerDraftStore } from '../../stores/ui/composer-draft.js';
import { composerLiveStore } from '../../stores/ui/composer-live.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { flushSessionDrafts } from '../../stores/ui/session-drafts.js';
import { addEvent } from '../../stores/workflow/actions/event.js';
import { Composer } from './composer.js';

const DRAFT = 'keep this draft';
const REFUSED: QueueSubmissionResult = {
  status: 'rejected',
  reason: 'queue-full',
  message: 'Queue full.',
};

const inputMode = {
  mode: 'normal',
  hint: '',
  questionEpoch: 0,
  setReviewMode: vi.fn(),
  setQuestionMode: vi.fn(),
  resolve: vi.fn(),
  resetMode: vi.fn(),
} as unknown as UseInputModeResult;

describe('a send the queue refuses', () => {
  let projectDir: string;
  beforeEach(() => {
    resetAllStores();
    projectDir = createTempDir('refused-send-');
    routerStore.navigate({
      to: 'workflow',
      run: makeRunRecord({ ref: { projectDir, sessionId: 'one' } }),
      execution: { kind: 'at-rest' },
    });
    addEvent({ type: 'planner_status', ts: Date.now(), phase: 'implementing', status: 'running' });
  });
  afterEach(() => {
    flushSessionDrafts();
    cleanupTempDir(projectDir);
  });

  async function press(ui: ReturnType<typeof renderThroughFilteredStdin>, bytes: string) {
    ui.pressBytes(bytes);
    await flushEffects();
  }

  function renderWorkflowComposer(enqueue: () => Promise<QueueSubmissionResult | null>) {
    const { handleInput } = createReviewInputHandler(inputMode, {
      openExternalEditor: async () => {},
      enqueue,
    });
    return renderThroughFilteredStdin(
      <Composer
        currentScreen="workflow"
        mode="normal"
        hint=""
        commands={[]}
        onRuntimeCommand={() => {}}
        onSubmit={(submission) => {
          composerLiveStore.setDraft(submission.document);
          void handleInput(submission.message);
        }}
      />,
      { cols: 120, rows: 40 },
    );
  }

  it('comes back in front of the draft a filled-in command stood over, and both are saved', async () => {
    const ui = renderWorkflowComposer(async () => REFUSED);
    await flushEffects();
    await press(ui, DRAFT);
    composerDraftStore.requestCommand('/steer ');
    await flushEffects();
    for (let i = 0; i < '/steer'.length; i++) await press(ui, '\u001b[D');
    await press(ui, '\u007f');
    expect(composerLiveStore.get().text).toBe('steer ');

    await press(ui, '\r');
    await flushEffects();

    expect(feedbackStore.get().message).toBe('Queue full.');
    expect(composerLiveStore.get().text).toBe(`steer\n${DRAFT}`);
    ui.unmount();
    await flushEffects();
    flushSessionDrafts();
    expect(readSessionDraft({ projectDir, sessionId: 'one' })).toEqual(
      createDraftDocument(`steer\n${DRAFT}`),
    );
  });

  it('comes back alone into an empty composer', async () => {
    const ui = renderWorkflowComposer(async () => REFUSED);
    await flushEffects();
    await press(ui, 'steer now');

    await press(ui, '\r');
    await flushEffects();

    expect(composerLiveStore.get().text).toBe('steer now');
    ui.unmount();
  });

  it('keeps the text typed while the queue was deciding', async () => {
    const decision = Promise.withResolvers<QueueSubmissionResult | null>();
    const ui = renderWorkflowComposer(() => decision.promise);
    await flushEffects();
    await press(ui, 'steer now');
    await press(ui, '\r');
    expect(composerLiveStore.get().text).toBe('');
    await press(ui, 'next words');

    decision.resolve(null);
    await flushEffects();

    expect(feedbackStore.get().message).toBe('Cannot queue message: no active workflow.');
    expect(composerLiveStore.get().text).toBe('steer now\nnext words');
    ui.unmount();
  });
});
