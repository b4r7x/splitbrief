import { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { useTheme } from '../../../components/theme.js';
import { SOFT_SEP } from '../../../components/separators.js';
import { borderStyleFor, glyph } from '../../../lib/glyphs.js';
import { cursorGlyph } from '../../../components/pickers/cursor-glyph.js';
import {
  approvalPromptStore,
  closeApprovalPrompt,
} from '../../../stores/approval-prompt/prompt.js';
import { overlayStore } from '../../../stores/ui/overlay.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { registerMouseZone } from '../../../lib/terminal/mouse-zones.js';
import { readConversationScrollSnapshot } from '../layout/snapshot.js';
import {
  APPROVAL_TITLE,
  CONFIRM_HINTS,
  CONFIRM_INSTRUCTION_PREFIX,
  CONFIRM_INSTRUCTION_SUFFIX,
  CONFIRM_QUESTION,
  CONFIRM_TITLE,
  PHRASE_ACCEPTED,
  STICKY_HINTS,
  STICKY_OPTIONS,
  formatApprovalActionDescription,
  getApprovalConfirmLabel,
  getApprovalPromptRows,
  getApprovalSeverityWord,
  getStickyOptionZones,
} from '../prompt-rows.js';
import { PROMPT_TYPEAHEAD_GRACE_MS } from '../prompt-grace.js';
import { CONFIRM_PHRASE } from '../../../core/approval/types.js';
import type { TieredApprovalResponse } from '../../../core/approval/types.js';

export const PROMPT_ZONE_Z = 50;

function triggerStickyOption(key: string): void {
  if (key === 'a') {
    closeApprovalPrompt({ decision: 'allow', scope: 'once' });
    return;
  }
  if (key === 's') {
    closeApprovalPrompt({ decision: 'allow', scope: 'session' });
    return;
  }
  if (key === 'w') {
    closeApprovalPrompt({ decision: 'allow', scope: 'always' });
    return;
  }
  closeApprovalPrompt();
}

type ConfirmStep = 'phrase' | 'reason';
type PromptIdentity = ((response: TieredApprovalResponse) => void) | null;

interface ApprovalPromptProps {
  clampedBoxRows?: number;
}

export function ApprovalPrompt({ clampedBoxRows }: ApprovalPromptProps) {
  const state = approvalPromptStore.use((s) => s);
  const [phraseInput, setPhraseInput] = useState('');
  const [reasonInput, setReasonInput] = useState('');
  const [confirmStep, setConfirmStep] = useState<ConfirmStep>('phrase');
  const [phraseError, setPhraseError] = useState('');
  const graceUntilRef = useRef(0);
  const promptIdentityRef = useRef<PromptIdentity>(null);
  const t = useTheme();
  const cols = terminalSizeStore.use((s) => s.cols);
  const rows = terminalSizeStore.use((s) => s.rows);
  const hasOverlay = overlayStore.use((s) => s.active !== 'none');

  const isActive = state.status === 'pending' && !hasOverlay;
  const promptRows = getApprovalPromptRows(state, cols);
  const promptIdentity = state.status === 'pending' ? state.resolve : null;

  if (promptIdentity !== promptIdentityRef.current) {
    promptIdentityRef.current = promptIdentity;
    setPhraseInput('');
    setReasonInput('');
    setConfirmStep('phrase');
    setPhraseError('');
    if (promptIdentity) graceUntilRef.current = Date.now() + PROMPT_TYPEAHEAD_GRACE_MS;
  }

  useInput(
    (input, key) => {
      if (state.status !== 'pending') return;
      if (Date.now() < graceUntilRef.current) return;
      const { request } = state;

      if (request.tier === 'sticky') {
        if (input === 'a' || input === 'A') {
          closeApprovalPrompt({ decision: 'allow', scope: 'once' });
          return;
        }
        if (input === 's' || input === 'S') {
          closeApprovalPrompt({ decision: 'allow', scope: 'session' });
          return;
        }
        if (input === 'w' || input === 'W') {
          closeApprovalPrompt({ decision: 'allow', scope: 'always' });
          return;
        }
        if (input === 'x' || input === 'X' || key.escape) {
          closeApprovalPrompt();
          return;
        }
        return;
      }

      if (request.tier === 'confirm') {
        if (confirmStep === 'phrase') {
          if (key.escape) {
            closeApprovalPrompt();
            return;
          }
          if (key.return) {
            if (phraseInput === CONFIRM_PHRASE) {
              setPhraseError('');
              setConfirmStep('reason');
            } else {
              setPhraseInput('');
              setPhraseError('incorrect phrase — try again');
            }
            return;
          }
          if (key.backspace || key.delete) {
            setPhraseInput((p) => p.slice(0, -1));
            return;
          }
          if (input && !key.ctrl && !key.meta) {
            setPhraseInput((p) => p + input);
            setPhraseError('');
          }
          return;
        }

        if (confirmStep === 'reason') {
          if (key.escape) {
            closeApprovalPrompt();
            return;
          }
          if (key.return) {
            if (reasonInput.trim()) {
              const reason = reasonInput.trim();
              closeApprovalPrompt({ decision: 'confirm', phrase: CONFIRM_PHRASE, reason });
            }
            return;
          }
          if (key.backspace || key.delete) {
            setReasonInput((r) => r.slice(0, -1));
            return;
          }
          if (input && !key.ctrl && !key.meta) {
            setReasonInput((r) => r + input);
          }
        }
      }
    },
    { isActive },
  );

  useEffect(() => {
    if (!isActive || state.status !== 'pending' || state.request.tier !== 'sticky') return;
    const { contentRect } = readConversationScrollSnapshot();
    const boxTop = contentRect.top + contentRect.height;
    const zones = getStickyOptionZones({
      boxTop,
      cols,
      promptRows: clampedBoxRows ?? promptRows,
      actionClass: state.request.actionClass,
      actionDescription: state.request.actionDescription,
    });
    const cleanups = zones.map((zone) =>
      registerMouseZone({
        id: `approval-option-${zone.key}`,
        left: zone.left,
        right: zone.right,
        top: zone.top,
        bottom: zone.bottom,
        z: PROMPT_ZONE_Z,
        onClick: () => triggerStickyOption(zone.key),
      }),
    );
    return () => {
      for (const cleanup of cleanups) cleanup();
    };
  }, [isActive, cols, rows, promptRows, clampedBoxRows, state]);

  if (state.status !== 'pending') return null;

  const { request } = state;
  const actionDescription = formatApprovalActionDescription(request.actionDescription);

  if (request.tier === 'sticky') {
    return (
      <Box
        flexDirection="column"
        borderStyle={borderStyleFor('bold')}
        borderColor={t.warning}
        paddingX={1}
        height={promptRows}
        width="100%"
        overflow="hidden"
        flexShrink={0}
      >
        <Text color={t.textDim}>{APPROVAL_TITLE}</Text>
        <Text> </Text>
        <Text>
          <Text color={t.warning}>{getApprovalSeverityWord(request.actionClass)}</Text>
          {'   '}
          {actionDescription}
        </Text>
        <Text> </Text>
        {STICKY_OPTIONS.map((option, index) => (
          <Text key={option.key}>
            {index === 0 ? <Text color={t.accent}>{cursorGlyph()}</Text> : '  '}
            <Text color={t.textDim}>{option.key}</Text>
            {'   '}
            {option.label}
            {option.note ? (
              <Text color={t.textDim}>
                {SOFT_SEP}
                {option.note}
              </Text>
            ) : null}
          </Text>
        ))}
        <Text> </Text>
        <Text color={t.textDim}>{STICKY_HINTS}</Text>
      </Box>
    );
  }

  if (request.tier === 'confirm') {
    return (
      <Box
        flexDirection="column"
        borderStyle={borderStyleFor('bold')}
        borderColor={t.error}
        paddingX={1}
        height={promptRows}
        width="100%"
        overflow="hidden"
        flexShrink={0}
      >
        <Text color={t.textDim}>{CONFIRM_TITLE}</Text>
        <Text> </Text>
        {confirmStep === 'phrase' && (
          <>
            <Text>
              <Text color={t.error}>{getApprovalSeverityWord(request.actionClass)}</Text>
              {'   '}
              {getApprovalConfirmLabel(request.actionClass)}
            </Text>
            <Text>
              {actionDescription}
              <Text color={t.textDim}>
                {SOFT_SEP}
                this cannot be undone
              </Text>
            </Text>
            <Text> </Text>
            <Text>
              {CONFIRM_INSTRUCTION_PREFIX}
              <Text bold>{CONFIRM_PHRASE}</Text>
              {CONFIRM_INSTRUCTION_SUFFIX}
            </Text>
            <Box height={1} overflow="hidden">
              <Text color={t.accent}>{`${glyph('prompt')} `}</Text>
              <Text wrap="truncate-end">{phraseInput}</Text>
              <Text color={t.accent}>{glyph('liveBar')}</Text>
            </Box>
            {phraseError ? (
              <Text color={t.error} dimColor>
                {phraseError}
              </Text>
            ) : (
              <Text> </Text>
            )}
            <Text color={t.textDim}>{CONFIRM_HINTS}</Text>
          </>
        )}
        {confirmStep === 'reason' && (
          <>
            <Text>
              <Text color={t.success}>{`${glyph('statusDone')} `}</Text>
              {PHRASE_ACCEPTED}
            </Text>
            <Text>{CONFIRM_QUESTION}</Text>
            <Box height={1} overflow="hidden">
              <Text color={t.accent}>{`${glyph('prompt')} `}</Text>
              <Text wrap="truncate-end">{reasonInput}</Text>
              <Text color={t.accent}>{glyph('liveBar')}</Text>
            </Box>
            <Text> </Text>
            <Text color={t.textDim}>{CONFIRM_HINTS}</Text>
          </>
        )}
      </Box>
    );
  }

  return null;
}
