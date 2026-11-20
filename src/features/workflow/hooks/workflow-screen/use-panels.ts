import { useLayoutEffect, useState } from 'react';
import { draftLength } from '../../../../core/composer/document.js';
import type { DraftSubmission } from '../../../../core/composer/submission.js';
import { plainUserMessage } from '../../../../core/types/user-input.js';
import {
  questionPromptStore,
  type QuestionPromptState,
} from '../../../../stores/prompts/question.js';
import { overlayStore } from '../../../../stores/ui/overlay.js';
import { composerDraftStore } from '../../../../stores/ui/composer-draft.js';
import { composerLiveStore } from '../../../../stores/ui/composer-live.js';
import { reviewKeysStore } from '../../../../stores/ui/review-keys.js';
import { resultMenuStore } from '../../../../stores/workflow/result-menu.js';
import type { RunRecord } from '../../../../core/sessions/run/record.js';
import { changedFileCount } from '../../closed/projections.js';
import { reviewDocumentOptions } from '../../prompt-rows/review-document.js';
import type { ResultMenuInput } from '../../result/options.js';
import { draftApprovesPlan } from '../../review-gate/commands.js';
import type { useWorkflowScreen } from './use-model.js';
import type { useReviewSelection } from './use-review-selection.js';

// A panel above the composer takes the keys when it opens, unless the user is typing: then a
// letter or ⏎ meant for the draft would choose one of its rows. `open` says that the panel exists,
// painted or not: a panel below an overlay stays open and keeps its focus. The draft the composer
// holds as the panel opens decides the first owner, read after the composer published it, so a
// panel that opens over a draft leaves the keys there. A draft put back in the composer decides the
// owner only when a key gets its first owner. On a key that has an owner only an explicit hand-off
// moves the keys, and a close or a new key settles the owner again.
export function usePanelFocus(key: string, open: boolean) {
  const empty = composerLiveStore.use((state) => state.empty);
  const restoring = composerDraftStore.use(
    (state) => state.request?.kind === 'prepend' && draftLength(state.request.document) > 0,
  );
  const [focus, setFocus] = useState<{ key: string; menu: boolean } | null>(null);
  useLayoutEffect(() => {
    setFocus((previous) => {
      if (!open) return null;
      if (previous?.key === key) return previous;
      return { key, menu: composerLiveStore.get().empty && !restoring };
    });
  }, [key, open, restoring]);
  const focused = open && (focus?.key === key ? focus.menu : empty);
  return { focused, setMenu: (menu: boolean) => setFocus({ key, menu }) };
}

interface PanelKey {
  key: string;
  open: boolean;
}

/** The focus of the recovery menu, the result menu and the gate, and what the result menu shows. */
export function usePanels(input: {
  recovery: PanelKey;
  /** The run on screen when it is ready to apply. */
  ready: RunRecord | undefined;
  stopMenuOpen: boolean;
  gate: PanelKey;
}) {
  const { ready } = input;
  const recovery = usePanelFocus(input.recovery.key, input.recovery.open);
  const resultMenuOpen = ready !== undefined && !input.stopMenuOpen;
  const resultKey = ready?.ref.sessionId ?? '';
  const [confirming, setConfirming] = useState(false);
  useLayoutEffect(() => {
    setConfirming(false);
  }, [resultKey, resultMenuOpen]);
  const result = usePanelFocus(resultKey, resultMenuOpen);
  const gate = usePanelFocus(input.gate.key, input.gate.open);
  const accepted =
    ready !== undefined && ready.hydration.kind === 'loaded'
      ? ready.hydration.state.acceptedAsIs
      : undefined;
  const resultMenu: ResultMenuInput = {
    override:
      ready !== undefined && ready.status.kind === 'ready-to-apply' ? ready.status.override : false,
    findings: accepted?.findings ?? [],
    redChecks: accepted?.redChecks,
    confirming,
    files: ready === undefined ? null : changedFileCount(ready.summary),
  };
  return { recovery, result, gate, resultMenuOpen, resultMenu, setConfirming };
}

/** Which panel reads the keys, and what the footer does with a submission, an empty ⏎ and Tab. */
export function usePanelKeys(input: {
  model: Pick<
    ReturnType<typeof useWorkflowScreen>,
    'hasOverlay' | 'promptPending' | 'inputMode' | 'handleInput' | 'onEmptySubmit'
  >;
  panels: ReturnType<typeof usePanels>;
  review: ReturnType<typeof useReviewSelection>;
  question: { structured: boolean; focus: QuestionPromptState['focus'] };
  stopMenuOpen: boolean;
  recoveryPromptOpen: boolean;
  /** The run on screen is ready to apply, so the result menu exists below the stop sheet too. */
  readyToApply: boolean;
  /** The preparation page covers this screen. */
  covered: boolean;
  requestedPromptRows: number;
  promptBoxRows: number;
}) {
  const { model, panels, review, question, stopMenuOpen, recoveryPromptOpen } = input;
  const { resultMenuOpen } = panels;
  useLayoutEffect(() => {
    resultMenuStore.setHeight(resultMenuOpen ? input.requestedPromptRows : null);
    return () => resultMenuStore.reset();
  }, [resultMenuOpen, input.requestedPromptRows]);

  const gateHoldsKeys = model.promptPending && panels.gate.focused;
  // An overlay, a focused gate or the preparation page holds the keys. Then neither the composer
  // nor a panel on this screen reads them.
  const keysHeldAbove = model.hasOverlay || gateHoldsKeys || input.covered;
  // The panel that holds the keys lets go of them for a command requested into the composer, typed
  // as a slash or picked in the palette. The stop sheet covers the panel below it, so closing the
  // sheet releases that panel too and Enter reaches the composer.
  const below = recoveryPromptOpen
    ? {
        focused: panels.recovery.focused,
        release: () => panels.recovery.setMenu(false),
      }
    : input.readyToApply
      ? {
          focused: panels.result.focused,
          release: () => panels.result.setMenu(false),
        }
      : question.structured && question.focus === 'menu'
        ? { focused: true, release: () => questionPromptStore.setFocus('composer') }
        : undefined;
  const takeKeys =
    input.covered || gateHoldsKeys
      ? undefined
      : stopMenuOpen
        ? () => {
            overlayStore.close();
            below?.release();
          }
        : model.hasOverlay || !below?.focused
          ? undefined
          : below.release;
  const commandRequest = composerDraftStore.use((state) =>
    state.request?.kind === 'command' ? state.request.epoch : null,
  );
  useLayoutEffect(() => {
    if (commandRequest !== null) takeKeys?.();
  }, [commandRequest]);

  const handleInput = (submission: Extract<DraftSubmission, { ok: true }>): void => {
    const { message } = submission;
    composerLiveStore.setDraft(submission.document);
    if (question.structured) {
      if (message.text.trim() !== '') void model.handleInput(message);
      return;
    }
    // The card opened over the draft, so the whole draft is the change request, whatever word it
    // opens with. A draft of only approve takes the Approve row.
    if (review.waits) {
      if (draftApprovesPlan(submission.document)) {
        void model.handleInput(plainUserMessage('approve'));
        return;
      }
      model.inputMode.resolve({ approved: false, action: 'revise', message });
      return;
    }
    if (review.artifact !== null && message.displayText.trim() === '') {
      // An open change request takes ⏎ as `send`, and an empty one has nothing to send.
      // With no row in view there is no row for ⏎ to take.
      if (review.draft !== null || input.promptBoxRows === 0) return;
      const row = reviewDocumentOptions(review.artifact)[review.latestSelected()];
      // The comment row hands the keyboard to the composer the same way a typed `c` does: one
      // empty change request, so there is one way into a review comment and not two.
      if (row === undefined || row.command === 'comment') {
        reviewKeysStore.requestComment();
        return;
      }
      void model.handleInput(plainUserMessage(row.command));
      return;
    }
    void model.handleInput(message);
  };

  return {
    keysHeldAbove,
    footer: {
      handleInput,
      onEmptySubmit: model.promptPending
        ? () => panels.gate.setMenu(true)
        : resultMenuOpen
          ? () => panels.result.setMenu(true)
          : review.waits
            ? () => review.setFocused(true)
            : model.onEmptySubmit,
      ...(model.promptPending
        ? {
            menuFocused: panels.gate.focused,
            onToggleMenu: () => {
              panels.gate.setMenu(true);
            },
          }
        : recoveryPromptOpen
          ? {
              menuFocused: panels.recovery.focused,
              onToggleMenu: () => {
                panels.recovery.setMenu(!panels.recovery.focused);
              },
            }
          : resultMenuOpen
            ? {
                menuFocused: panels.result.focused,
                onToggleMenu: () => {
                  panels.result.setMenu(!panels.result.focused);
                },
              }
            : review.waits
              ? { onToggleMenu: () => review.setFocused(true) }
              : {}),
      panelHoldsKeys: takeKeys !== undefined,
      disabled: keysHeldAbove,
    },
  };
}
