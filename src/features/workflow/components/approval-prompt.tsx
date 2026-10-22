import { useRef, useState } from 'react';
import { approvalPromptStore } from '../../../stores/approval-prompt/prompt.js';
import { overlayStore } from '../../../stores/ui/overlay.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import {
  confirmCardFits,
  getConfirmPanelRows,
  ownConfirmFrame,
  type ConfirmFrame,
} from '../prompt-rows/approval.js';
import { PROMPT_TYPEAHEAD_GRACE_MS } from '../../../lib/terminal/typeahead-grace.js';
import { overlayRect } from '../../../core/navigation/overlay-rect.js';
import type { TieredApprovalResponse } from '../../../core/approval/types.js';
import type { OverlayCard } from '../../../components/overlays/overlay-panel.js';
import { ConfirmApprovalPrompt, PROMPT_ZONE_Z } from './approval-prompt/confirm.js';
import { DocumentReviewPrompt } from './approval-prompt/document.js';
import type { ReviewArtifact } from '../prompt-rows/approval.js';

export { PROMPT_ZONE_Z };

export interface ReviewPanelProps {
  artifact: ReviewArtifact;
  confirms: readonly string[];
  /** The rows the panel may take (`getReviewPanelBudget`); the page budgets the same number. */
  budgetRows: number;
  selectedIndex: number;
  commenting: boolean;
}

interface ApprovalPromptProps {
  clampedBoxRows?: number;
  /** Without a card, or where the card cannot keep every line and key, the panel draws its own box. */
  card?: OverlayCard;
  review?: ReviewPanelProps | undefined;
}

type PromptIdentity = ((response: TieredApprovalResponse) => void) | null;

export function ApprovalPrompt({ clampedBoxRows, card, review }: ApprovalPromptProps) {
  const state = approvalPromptStore.use((s) => s);
  const graceUntilRef = useRef(0);
  const promptIdentityRef = useRef<PromptIdentity>(null);
  const [generation, setGeneration] = useState(0);
  const cols = terminalSizeStore.use((s) => s.cols);
  const rows = terminalSizeStore.use((s) => s.rows);
  const hasOverlay = overlayStore.use((s) => s.active !== 'none');

  const isActive = state.status === 'pending' && !hasOverlay;
  const promptIdentity = state.status === 'pending' ? state.resolve : null;

  if (promptIdentity !== promptIdentityRef.current) {
    promptIdentityRef.current = promptIdentity;
    if (promptIdentity) {
      graceUntilRef.current = Date.now() + PROMPT_TYPEAHEAD_GRACE_MS;
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
  const frame =
    cardFrame !== undefined && confirmCardFits(state.request, cardFrame, clampedBoxRows ?? rows)
      ? cardFrame
      : ownConfirmFrame(cols);

  return (
    <ConfirmApprovalPrompt
      key={generation}
      request={state.request}
      frame={frame}
      promptRows={getConfirmPanelRows(state.request, frame)}
      clampedBoxRows={clampedBoxRows}
      isActive={isActive}
      graceUntil={graceUntilRef.current}
    />
  );
}
