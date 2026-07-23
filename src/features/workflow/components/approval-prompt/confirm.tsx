import { useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { useTheme } from '../../../../components/theme.js';
import { SOFT_SEP } from '../../../../components/separators.js';
import { borderStyleFor, glyph } from '../../../../lib/glyphs.js';
import { closeApprovalPrompt } from '../../../../stores/approval-prompt/prompt.js';
import {
  CONFIRM_HINTS,
  CONFIRM_INSTRUCTION_PREFIX,
  CONFIRM_INSTRUCTION_SUFFIX,
  CONFIRM_QUESTION,
  CONFIRM_TITLE,
  PHRASE_ACCEPTED,
  formatApprovalActionDescription,
  getApprovalConfirmLabel,
  getApprovalSeverityWord,
} from '../../prompt-rows/approval.js';
import { CONFIRM_PHRASE } from '../../../../core/approval/types.js';
import type {
  TieredApprovalRequest,
  TieredApprovalResponse,
} from '../../../../core/approval/types.js';

type ConfirmStep = 'phrase' | 'reason';
type PromptIdentity = ((response: TieredApprovalResponse) => void) | null;

interface ConfirmApprovalPromptProps {
  request: TieredApprovalRequest;
  promptRows: number;
  isActive: boolean;
  graceUntil: number;
  promptIdentity: PromptIdentity;
}

export function ConfirmApprovalPrompt({
  request,
  promptRows,
  isActive,
  graceUntil,
  promptIdentity,
}: ConfirmApprovalPromptProps) {
  const [phraseInput, setPhraseInput] = useState('');
  const [reasonInput, setReasonInput] = useState('');
  const [confirmStep, setConfirmStep] = useState<ConfirmStep>('phrase');
  const [phraseError, setPhraseError] = useState('');
  const promptIdentityRef = useRef<PromptIdentity>(null);
  const t = useTheme();
  const actionDescription = formatApprovalActionDescription(request.actionDescription);

  if (promptIdentity !== promptIdentityRef.current) {
    promptIdentityRef.current = promptIdentity;
    setPhraseInput('');
    setReasonInput('');
    setConfirmStep('phrase');
    setPhraseError('');
  }

  useInput(
    (input, key) => {
      if (Date.now() < graceUntil) return;
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
    },
    { isActive },
  );

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
