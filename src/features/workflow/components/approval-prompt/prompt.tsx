import { composerLiveStore } from '../../../../stores/ui/composer-live.js';
import { isCommandDraft } from '../../../../core/composer/submission.js';
import { isBlankDraft } from '../../../../components/composer/use-paste-drafts.js';
import { unfocusedPromptLegend } from '../../prompt-rows/approval.js';
import { approvalBoxTextWidth } from '../../prompt-rows/measure.js';
import { useRef, useState } from 'react';
import { approvalPromptStore } from '../../../../stores/prompts/approval.js';
import { overlayStore, selectHasOverlay } from '../../../../stores/ui/overlay.js';
import { terminalSizeStore } from '../../../../stores/ui/terminal-size.js';
import {
  confirmCardFits,
  getConfirmPanelRows,
  ownConfirmFrame,
  type ConfirmFrame,
} from '../../prompt-rows/confirm-panel.js';
import { PROMPT_TYPEAHEAD_GRACE_MS } from '../../../../lib/terminal/typeahead-grace.js';
import { overlayRect } from '../../../../core/navigation/overlay-rect.js';
import { getChromeContentWidth } from '../../layout/chrome-rows.js';
import type { TieredApprovalResponse } from '../../../../core/approval/types.js';
import type { OverlayCard } from '../../../../components/overlays/panel.js';
import { ConfirmApprovalPrompt } from './confirm.js';
import { DocumentReviewPrompt } from './document.js';
import type { ReviewArtifact } from '../../prompt-rows/review-document.js';
import type { ReviewDraftTarget } from '../../review-gate/commands.js';

export interface ReviewPanelProps {
  artifact: ReviewArtifact;
  confirms: readonly string[];
  /** The rows the panel may take (`getReviewPanelBudget`); the page budgets the same number. */
  budgetRows: number;
  selectedIndex: number;
  draft: ReviewDraftTarget | null;
  /** False while a draft typed before the card opened keeps the keys in the composer. */
  focused: boolean;
}

interface ApprovalPromptProps {
  clampedBoxRows?: number;
  /** Without a card, or where the card cannot keep every line and key, the panel draws its own box. */
  card?: OverlayCard;
  review?: ReviewPanelProps | undefined;
  /** False while the composer below keeps the keys: a gate that opened over a draft. */
  focused?: boolean;
  /** True in a phase where the composer below queues its plain words for a seat. */
  queues?: boolean;
  onComposerFocus?: (() => void) | undefined;
}

type PromptIdentity = ((response: TieredApprovalResponse) => void) | null;

export function ApprovalPrompt({
  clampedBoxRows,
  card,
  review,
  focused = true,
  queues = false,
  onComposerFocus,
}: ApprovalPromptProps) {
  const draft = composerLiveStore.use((state) => state.document);
  const state = approvalPromptStore.use((s) => s);
  const graceUntilRef = useRef(0);
  const promptIdentityRef = useRef<PromptIdentity>(null);
  const [generation, setGeneration] = useState(0);
  const cols = terminalSizeStore.use((s) => s.cols);
  const rows = terminalSizeStore.use((s) => s.rows);
  const hasOverlay = overlayStore.use(selectHasOverlay);

  const isActive = state.status === 'pending' && !hasOverlay && focused;
  const promptIdentity = state.status === 'pending' ? state.resolve : null;

  if (promptIdentity !== promptIdentityRef.current) {
    promptIdentityRef.current = promptIdentity;
    if (promptIdentity) {
      // A gate that opens without the keys sends a key in flight to the composer, and a later Tab
      // that gives it the keys is no key in flight.
      graceUntilRef.current = focused ? Date.now() + PROMPT_TYPEAHEAD_GRACE_MS : 0;
      setGeneration((value) => value + 1);
    }
  }

  if (state.status !== 'pending') {
    // A tiered gate takes the zone from the review panel: only one of them can own the keyboard.
    return review === undefined ? null : (
      <DocumentReviewPrompt {...review} clampedBoxRows={clampedBoxRows} />
    );
  }

  const cardFrame: ConfirmFrame | undefined = card && {
    width: overlayRect({ cols, rows, density: card.density }).innerWidth,
    kind: 'card',
    card,
  };
  const paintWidth = card === undefined ? getChromeContentWidth(cols) : cols;
  const composerLegend = unfocusedPromptLegend({
    blank: isBlankDraft(draft),
    command: isCommandDraft(draft),
    words: queues
      ? { long: '⏎ queues the typed correction', short: '⏎ queues the correction' }
      : null,
    width: approvalBoxTextWidth(paintWidth),
  });
  const frame =
    cardFrame !== undefined && confirmCardFits(state.request, cardFrame, clampedBoxRows ?? rows)
      ? cardFrame
      : // The box can use the page's whole width when the facts need it.
        ownConfirmFrame(paintWidth, state.request, composerLegend, clampedBoxRows ?? rows);

  return (
    <ConfirmApprovalPrompt
      key={generation}
      request={state.request}
      frame={frame}
      promptRows={getConfirmPanelRows(state.request, frame)}
      clampedBoxRows={clampedBoxRows}
      isActive={isActive}
      focused={focused}
      composerLegend={composerLegend}
      onComposerFocus={onComposerFocus}
      graceUntil={graceUntilRef.current}
    />
  );
}
