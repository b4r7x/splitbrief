import { useRef, useState } from 'react';
import { approvalPromptStore } from '../../../stores/approval-prompt/prompt.js';
import { overlayStore } from '../../../stores/ui/overlay.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { getApprovalPromptRows } from '../prompt-rows/approval.js';
import { PROMPT_TYPEAHEAD_GRACE_MS } from '../../../lib/terminal/typeahead-grace.js';
import type { TieredApprovalResponse } from '../../../core/approval/types.js';
import { ConfirmApprovalPrompt } from './approval-prompt/confirm.js';
import { DocumentReviewPrompt } from './approval-prompt/document.js';
import type { ReviewArtifact } from '../prompt-rows/approval.js';
import { PROMPT_ZONE_Z, StickyApprovalPrompt } from './approval-prompt/sticky.js';

export { PROMPT_ZONE_Z };

export interface ReviewPanelProps {
  artifact: ReviewArtifact;
  selectedIndex: number;
  commenting: boolean;
}

interface ApprovalPromptProps {
  clampedBoxRows?: number;
  review?: ReviewPanelProps | undefined;
}

type PromptIdentity = ((response: TieredApprovalResponse) => void) | null;

export function ApprovalPrompt({ clampedBoxRows, review }: ApprovalPromptProps) {
  const state = approvalPromptStore.use((s) => s);
  const graceUntilRef = useRef(0);
  const promptIdentityRef = useRef<PromptIdentity>(null);
  const [generation, setGeneration] = useState(0);
  const cols = terminalSizeStore.use((s) => s.cols);
  const hasOverlay = overlayStore.use((s) => s.active !== 'none');

  const isActive = state.status === 'pending' && !hasOverlay;
  const promptRows = getApprovalPromptRows(state, cols);
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

  const { request } = state;

  if (request.tier === 'sticky') {
    return (
      <StickyApprovalPrompt
        key={generation}
        request={request}
        promptRows={promptRows}
        clampedBoxRows={clampedBoxRows}
        isActive={isActive}
        graceUntil={graceUntilRef.current}
      />
    );
  }

  if (request.tier === 'confirm') {
    return (
      <ConfirmApprovalPrompt
        key={generation}
        request={request}
        promptRows={promptRows}
        clampedBoxRows={clampedBoxRows}
        isActive={isActive}
        graceUntil={graceUntilRef.current}
      />
    );
  }

  return null;
}
