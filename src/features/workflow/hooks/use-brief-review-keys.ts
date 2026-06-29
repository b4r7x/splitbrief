import { useEffect } from 'react';
import { useInput } from 'ink';
import { overlayStore } from '../../../stores/ui/overlay.js';
import { controlsStore } from '../../../stores/ui/controls.js';
import { getVisibleBriefWindow, reviewStore } from '../../../stores/workflow/review.js';
import { focusStore } from '../../../stores/ui/focus.js';
import { completionStore } from '../../../stores/ui/completion.js';
import { approvalPromptStore } from '../../../stores/approval-prompt/prompt.js';
import { costApprovalStore } from '../../../stores/cost-approval/prompt.js';
import { feedbackStore } from '../../../stores/ui/feedback.js';
import { formatCopyResult } from '../../../core/runtime/commands/types.js';
import { toErrorMessage } from '../../../utils/format-errors.js';
import { useStores } from '../../../stores/use-stores.js';
import type { CopyResult, CopyTarget } from '../../../core/runtime/commands/types.js';
import type { Focus } from '../../../stores/ui/focus.js';

type CopyTargetFn = (target: CopyTarget) => Promise<CopyResult>;

const emptyCopyTarget: CopyTargetFn = () => Promise.resolve('empty');

function yankFocused(copyTarget: CopyTargetFn) {
  const focus = focusStore.get();
  if (!focus) return;
  void copyTarget('brief')
    .then((result) => feedbackStore.setMessage(formatCopyResult(result)))
    .catch((err) => feedbackStore.setError(`Could not copy: ${toErrorMessage(err)}`));
}

interface UseBriefReviewKeysOptions {
  isActive: boolean;
  copyTarget?: CopyTargetFn | undefined;
  canCopyFocused?: ((focus: Focus | null) => boolean) | undefined;
}

export function useBriefReviewKeys({
  isActive,
  copyTarget = emptyCopyTarget,
  canCopyFocused = () => false,
}: UseBriefReviewKeysOptions) {
  const [overlay, approval, cost, completion] = useStores(
    overlayStore,
    approvalPromptStore,
    costApprovalStore,
    completionStore,
  );
  const focus = focusStore.use((f) => f);
  const focusResolvable = canCopyFocused(focus);
  const briefReviewActive = reviewStore.use((s) => {
    if (s.filePath === null || s.briefSources.length === 0) return false;
    return getVisibleBriefWindow(s).count > 0;
  });
  const inReviewMode = controlsStore.use((c) => c.inputMode === 'review');
  const { active: overlayActive, exclusive: overlayExclusive } = overlay;
  const isOpen = overlayActive !== 'none';
  const promptPending = approval.status === 'pending' || cost.status === 'pending';
  const completionOpen = completion.open;

  const keysBlocked = !isActive || isOpen || overlayExclusive || promptPending || completionOpen;

  useEffect(() => {
    return () => focusStore.clear();
  }, []);

  useInput(
    (_input, key) => {
      if (!key.upArrow && !key.downArrow) return;
      const { briefSources } = reviewStore.get();
      const { start, count } = getVisibleBriefWindow();
      if (briefSources.length === 0 || count <= 0) return;
      const windowEnd = start + count - 1;
      const focus = focusStore.get();
      if (focus === null) {
        focusStore.set('brief', start);
        reviewStore.setScrollOffset(start);
        return;
      }
      const next = key.downArrow
        ? Math.min(focus.index + 1, windowEnd)
        : Math.max(focus.index - 1, start);
      focusStore.set('brief', next);
      reviewStore.setScrollOffset(next);
    },
    {
      isActive:
        isActive &&
        briefReviewActive &&
        inReviewMode &&
        !isOpen &&
        !overlayExclusive &&
        !promptPending &&
        !completionOpen,
    },
  );

  useInput(
    (input, key) => {
      if (input === 'y' && !key.ctrl && !key.meta) {
        yankFocused(copyTarget);
        focusStore.clear();
        return;
      }
      if (key.upArrow || key.downArrow) return;
      focusStore.clear();
    },
    {
      isActive: focusResolvable && isActive && !keysBlocked,
    },
  );
}
