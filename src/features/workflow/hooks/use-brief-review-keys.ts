import { useEffect, useLayoutEffect } from 'react';
import { useInput } from 'ink';
import { isTextEntryInput, isUnmodifiedYInput } from '../../../lib/terminal/text-entry.js';
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
  const reviewOwnerToken = reviewStore.get().ownerToken;
  void copyTarget('brief')
    .then((result) => {
      if (focusStore.get() !== focus || reviewStore.get().ownerToken !== reviewOwnerToken) {
        return;
      }
      feedbackStore.setMessage(formatCopyResult(result));
      const copied = result === 'native' || result === 'tmux-buffer' || result === 'osc52';
      if (copied) focusStore.clear();
    })
    .catch((err) => {
      if (focusStore.get() !== focus || reviewStore.get().ownerToken !== reviewOwnerToken) {
        return;
      }
      feedbackStore.setError(`Could not copy: ${toErrorMessage(err)}`);
    });
}

interface UseBriefReviewKeysOptions {
  isActive: boolean;
  copyTarget?: CopyTargetFn | undefined;
  canCopyFocused?: ((focus: Focus | null) => boolean) | undefined;
}

export type BriefReviewNavigate = (direction: 'up' | 'down') => boolean;

export function useBriefReviewKeys({
  isActive,
  copyTarget = emptyCopyTarget,
  canCopyFocused = () => false,
}: UseBriefReviewKeysOptions): BriefReviewNavigate {
  const [overlay, approval, cost, completion] = useStores(
    overlayStore,
    approvalPromptStore,
    costApprovalStore,
    completionStore,
  );
  const focus = focusStore.use((f) => f);
  const focusResolvable = canCopyFocused(focus);
  const review = reviewStore.use((state) => state);
  const visibleWindow = getVisibleBriefWindow(review);
  const briefCount = Math.min(review.briefSources.length, review.renderedLineCount);
  const visibleBriefCount = Math.min(
    visibleWindow.count,
    Math.max(0, briefCount - visibleWindow.start),
  );
  const briefReviewActive = review.filePath !== null && briefCount > 0 && visibleBriefCount > 0;
  const inReviewMode = controlsStore.use((c) => c.inputMode === 'review');
  const focusedBriefValid =
    focus?.region === 'brief' &&
    focus.index >= 0 &&
    focus.index < briefCount &&
    briefReviewActive &&
    inReviewMode;
  const { active: overlayActive, exclusive: overlayExclusive } = overlay;
  const isOpen = overlayActive !== 'none';
  const promptPending = approval.status === 'pending' || cost.status === 'pending';
  const completionOpen = completion.open;

  const keysBlocked = !isActive || isOpen || overlayExclusive || promptPending || completionOpen;

  useEffect(() => {
    return () => focusStore.clear();
  }, []);

  useLayoutEffect(() => {
    if (focus?.region === 'brief' && !focusedBriefValid) {
      focusStore.clear();
      return;
    }
    if (!briefReviewActive) return;

    let nextOffset = visibleWindow.start;

    if (focus !== null && focus.region === 'brief') {
      const selectedIndex = Math.min(Math.max(focus.index, 0), briefCount - 1);
      if (selectedIndex < visibleWindow.start) {
        nextOffset = selectedIndex;
      } else if (selectedIndex >= visibleWindow.start + visibleBriefCount) {
        nextOffset = selectedIndex - visibleBriefCount + 1;
      }
      if (selectedIndex !== focus.index) focusStore.set('brief', selectedIndex);
    }

    if (review.scrollOffset !== nextOffset) reviewStore.setScrollOffset(nextOffset);
  }, [
    briefCount,
    briefReviewActive,
    focus,
    focusedBriefValid,
    inReviewMode,
    review.scrollOffset,
    visibleBriefCount,
    visibleWindow.start,
  ]);

  const navigate: BriefReviewNavigate = (direction) => {
    if (
      !isActive ||
      !briefReviewActive ||
      !inReviewMode ||
      isOpen ||
      overlayExclusive ||
      promptPending ||
      completionOpen
    ) {
      return false;
    }
    const currentReview = reviewStore.get();
    const currentBriefCount = Math.min(
      currentReview.briefSources.length,
      currentReview.renderedLineCount,
    );
    const { start, count } = getVisibleBriefWindow(currentReview);
    const visibleCount = Math.min(count, Math.max(0, currentBriefCount - start));
    if (currentBriefCount === 0 || visibleCount === 0) return false;
    const currentFocus = focusStore.get();
    if (currentFocus === null) {
      focusStore.set('brief', start);
      if (currentReview.scrollOffset !== start) reviewStore.setScrollOffset(start);
      return true;
    }
    const delta = direction === 'down' ? 1 : -1;
    const next = Math.min(Math.max(currentFocus.index + delta, 0), currentBriefCount - 1);
    const nextOffset =
      next < start ? next : next >= start + visibleCount ? next - visibleCount + 1 : start;
    focusStore.set('brief', next);
    if (currentReview.scrollOffset !== nextOffset) reviewStore.setScrollOffset(nextOffset);
    return true;
  };

  useInput(
    (_input, key) => {
      if (key.shift || key.ctrl || key.meta || key.super || key.hyper) return;
      if (key.upArrow) {
        navigate('up');
      } else if (key.downArrow) {
        navigate('down');
      }
    },
    {
      isActive: focusedBriefValid && isActive && !keysBlocked,
    },
  );

  useInput(
    (input, key) => {
      if (isUnmodifiedYInput(input, key) && focusResolvable && focusedBriefValid) {
        yankFocused(copyTarget);
        return;
      }
      if (key.upArrow || key.downArrow) {
        if (!focusedBriefValid) focusStore.clear();
        return;
      }
      if (key.escape || key.pageUp || key.pageDown || key.home || key.end) return;
      if (isTextEntryInput(input, key)) return;
      if (key.ctrl || key.meta || key.super || key.hyper) return;
      focusStore.clear();
    },
    {
      isActive: focus?.region === 'brief' && isActive && !keysBlocked,
    },
  );

  return navigate;
}
