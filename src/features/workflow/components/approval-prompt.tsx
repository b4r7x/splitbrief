import { useRef } from 'react';
import { approvalPromptStore } from '../../../stores/approval-prompt/prompt.js';
import { overlayStore } from '../../../stores/ui/overlay.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { getApprovalPromptRows } from '../prompt-rows/approval.js';
import { PROMPT_TYPEAHEAD_GRACE_MS } from '../prompt-grace.js';
import type { TieredApprovalResponse } from '../../../core/approval/types.js';
import { ConfirmApprovalPrompt } from './approval-prompt/confirm.js';
import { PROMPT_ZONE_Z, StickyApprovalPrompt } from './approval-prompt/sticky.js';

export { PROMPT_ZONE_Z };

interface ApprovalPromptProps {
  clampedBoxRows?: number;
}

type PromptIdentity = ((response: TieredApprovalResponse) => void) | null;

export function ApprovalPrompt({ clampedBoxRows }: ApprovalPromptProps) {
  const state = approvalPromptStore.use((s) => s);
  const graceUntilRef = useRef(0);
  const promptIdentityRef = useRef<PromptIdentity>(null);
  const cols = terminalSizeStore.use((s) => s.cols);
  const hasOverlay = overlayStore.use((s) => s.active !== 'none');

  const isActive = state.status === 'pending' && !hasOverlay;
  const promptRows = getApprovalPromptRows(state, cols);
  const promptIdentity = state.status === 'pending' ? state.resolve : null;

  if (promptIdentity !== promptIdentityRef.current) {
    promptIdentityRef.current = promptIdentity;
    if (promptIdentity) graceUntilRef.current = Date.now() + PROMPT_TYPEAHEAD_GRACE_MS;
  }

  if (state.status !== 'pending') return null;

  const { request } = state;

  if (request.tier === 'sticky') {
    return (
      <StickyApprovalPrompt
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
        request={request}
        promptRows={promptRows}
        isActive={isActive}
        graceUntil={graceUntilRef.current}
        promptIdentity={promptIdentity}
      />
    );
  }

  return null;
}
