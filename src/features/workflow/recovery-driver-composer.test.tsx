import { useEffect } from 'react';
import { realpathSync, writeFileSync } from 'node:fs';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makePreparedExecution } from '#testing/helpers/factories/prepared-execution.js';
import { makeRecoveryIssue } from '#testing/helpers/factories/recovery.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { flushEffects, renderFeature } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { Composer } from '../../components/composer/composer.js';
import { plainUserMessage } from '../../core/types/user-input.js';
import type { DraftDocument } from '../../core/schemas/draft-document.js';
import { configStore } from '../../stores/project/config.js';
import { composerDraftStore } from '../../stores/ui/composer-draft.js';
import { composerLiveStore } from '../../stores/ui/composer-live.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { inputHistoryStore } from '../../stores/ui/input-history.js';
import { attachmentsStore } from '../../stores/workflow/attachments.js';
import { WORKFLOW_USER_CANCELLED_ABORT_REASON } from '../../engine/events/workflow-cancel.js';
import { useInputMode, type UseInputModeResult } from './hooks/use-input-mode.js';
import { createRecoveryDriver } from './recovery-driver.js';

function RecoveryComposerHarness({ capture }: { capture: { current: UseInputModeResult | null } }) {
  const inputMode = useInputMode();
  useEffect(() => {
    capture.current = inputMode;
  });
  return (
    <Composer
      commands={[]}
      currentScreen="workflow"
      mode={inputMode.mode}
      hint={inputMode.hint}
      questionEpoch={inputMode.questionEpoch}
      onSubmit={(submission) => inputMode.resolve(submission.message)}
      onRuntimeCommand={() => {}}
      listProjectFiles={async () => []}
    />
  );
}

afterEach(resetAllStores);

it('restores the whole refused recovery draft when the question prompt is re-armed', async () => {
  const projectDir = createTempDir('recovery-composer');
  onTestFinished(() => cleanupTempDir(projectDir));
  const config = makeConfig({ planner: { kind: 'cli', tool: 'claude-code' } });
  configStore.__testReset({ projectDir, config });
  const state = makeImplState([makeTask({ id: 'T001', status: 'failed' })], {
    pendingRecovery: makeRecoveryIssue(),
  });
  const prepared = makePreparedExecution({
    projectDir,
    sessionId: 'recovery-composer',
    feature: 'recovery composer',
    config,
    resumeState: state,
  });
  const imagePath = `${projectDir}/draft.png`;
  writeFileSync(imagePath, 'png');
  const image = {
    id: 'draft-image',
    kind: 'image' as const,
    path: realpathSync(imagePath),
    mimeType: 'image/png' as const,
    sizeBytes: 3,
  };
  const document: DraftDocument = {
    version: 1,
    parts: [
      { kind: 'text', text: 'fix @/definitely-missing/context.txt ' },
      { kind: 'image', attachment: image },
    ],
  };
  attachmentsStore.replacePendingImages([{ ...image, id: 'pending-image' }]);
  inputHistoryStore.hydrate(['Earlier']);
  const history = inputHistoryStore.get();
  const pendingImages = attachmentsStore.peek();
  const capture: { current: UseInputModeResult | null } = { current: null };
  const ui = renderFeature(<RecoveryComposerHarness capture={capture} />, { cols: 160, rows: 24 });
  onTestFinished(ui.unmount);
  await flushEffects();
  if (capture.current === null) throw new Error('Expected the mounted input mode');
  const controller = new AbortController();
  const driver = createRecoveryDriver({
    prepared,
    configOfRun: prepared.sourceConfig,
    inputMode: capture.current,
    abortedRef: { current: false },
    retentionNoticeHandled: { current: true },
    sink: () => {},
    setInlineResume: () => {},
  });
  const result = driver({ state, controller, republishPrompt: false }).catch((err: unknown) => err);
  onTestFinished(() => controller.abort());
  await vi.waitFor(() => expect(capture.current?.questionEpoch).toBe(1));
  await flushEffects();
  composerDraftStore.requestDocument(document);
  await flushEffects();

  capture.current.resolve(plainUserMessage('r'));
  await vi.waitFor(() => expect(capture.current?.questionEpoch).toBe(2));
  await flushEffects();

  expect(feedbackStore.get()).toEqual({
    message: 'Cannot send: file not found. Check the path and try again. File: context.txt.',
    isError: true,
  });
  expect(composerLiveStore.get().document).toEqual(document);
  expect(inputHistoryStore.get()).toBe(history);
  expect(attachmentsStore.peek()).toEqual(pendingImages);
  expect(ui.lastFrame()).toContain('fix @/definitely-missing/context.txt');
  expect(ui.lastFrame()).toContain('[image #1]');

  controller.abort();
  expect(await result).toBe(WORKFLOW_USER_CANCELLED_ABORT_REASON);
});

it('runs a slash command typed under a recovery menu and never takes one as the correction', async () => {
  const projectDir = createTempDir('recovery-composer-command');
  onTestFinished(() => cleanupTempDir(projectDir));
  const config = makeConfig({ planner: { kind: 'cli', tool: 'claude-code' } });
  configStore.__testReset({ projectDir, config });
  const state = makeImplState([makeTask({ id: 'T001', status: 'failed' })], {
    pendingRecovery: makeRecoveryIssue(),
  });
  const prepared = makePreparedExecution({
    projectDir,
    sessionId: 'recovery-composer-command',
    feature: 'recovery composer',
    config,
    resumeState: state,
  });
  const commands: string[] = [];
  const capture: { current: UseInputModeResult | null } = { current: null };
  function Harness() {
    const inputMode = useInputMode();
    useEffect(() => {
      capture.current = inputMode;
    });
    return (
      <Composer
        commands={[]}
        currentScreen="workflow"
        mode={inputMode.mode}
        hint={inputMode.hint}
        questionEpoch={inputMode.questionEpoch}
        onSubmit={(submission) => inputMode.resolve(submission.message)}
        onRuntimeCommand={(command) => commands.push(command)}
        listProjectFiles={async () => []}
      />
    );
  }
  const ui = renderFeature(<Harness />, { cols: 160, rows: 24 });
  onTestFinished(ui.unmount);
  await flushEffects();
  if (capture.current === null) throw new Error('Expected the mounted input mode');
  const controller = new AbortController();
  const applied: string[] = [];
  const driver = createRecoveryDriver({
    prepared,
    configOfRun: prepared.sourceConfig,
    inputMode: capture.current,
    abortedRef: { current: false },
    retentionNoticeHandled: { current: true },
    sink: (event) => {
      if (event.type === 'recovery_action_selected') applied.push(event.action);
    },
    setInlineResume: () => {},
  });
  const result = driver({ state, controller, republishPrompt: false }).catch((err: unknown) => err);
  onTestFinished(() => controller.abort());
  await vi.waitFor(() => expect(capture.current?.questionEpoch).toBe(1));
  await flushEffects();

  ui.stdin.write('/scroll top');
  await flushEffects();
  ui.stdin.write('\r');
  await flushEffects();

  expect(commands).toEqual(['/scroll top']);
  expect(capture.current.mode).toBe('question');
  expect(capture.current.questionEpoch).toBe(1);
  expect(composerLiveStore.get().empty).toBe(true);

  composerDraftStore.request('/scroll top');
  await flushEffects();
  capture.current.resolve(plainUserMessage('r'));
  await vi.waitFor(() => expect(capture.current?.questionEpoch).toBe(2));
  await flushEffects();

  expect(feedbackStore.get()).toEqual({
    message: 'A slash command is not a message. Run it from the composer.',
    isError: true,
  });
  expect(composerLiveStore.get().document).toEqual({
    version: 1,
    parts: [{ kind: 'text', text: '/scroll top' }],
  });
  expect(applied).toEqual([]);

  controller.abort();
  expect(await result).toBe(WORKFLOW_USER_CANCELLED_ABORT_REASON);
});
