import { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { useTheme } from '../../../../components/theme.js';
import { borderStyleFor, glyph } from '../../../../lib/glyphs.js';
import { NO_CURSOR, cursorGlyph } from '../../../../components/pickers/cursor-glyph.js';
import { closeApprovalPrompt } from '../../../../stores/approval-prompt/prompt.js';
import { terminalSizeStore } from '../../../../stores/ui/terminal-size.js';
import { registerMouseZone } from '../../../../lib/terminal/mouse-zones.js';
import { readConversationScrollSnapshot } from '../../layout/snapshot.js';
import {
  CONFIRM_NUDGE,
  CONFIRM_QUESTION,
  CONFIRM_REASON_HINTS,
  CONFIRM_REASON_OPTIONAL,
  CONFIRM_REASON_UNSTATED,
  GATE_TITLE,
  IRREVERSIBLE_NOTE,
  approvalKeyColumnWidth,
  approvalOptionKeyCell,
  approvalOptionLabelText,
  approvalSubjectText,
  getApprovalConfirmLabel,
  getApprovalSeverityWord,
  getConfirmChooseHints,
  getConfirmOptionZones,
  getConfirmOptions,
  isIrreversibleActionClass,
} from '../../prompt-rows/approval.js';
import { SOFT_SEP } from '../../../../components/separators.js';
import { CONFIRM_PHRASE } from '../../../../core/approval/types.js';
import type {
  TieredApprovalRequest,
  TieredApprovalResponse,
} from '../../../../core/approval/types.js';
import { approvalTextWidth } from '../../prompt-rows/measure.js';
import { PROMPT_ZONE_Z } from './sticky.js';

type ConfirmStep = 'choose' | 'reason';
type PromptIdentity = ((response: TieredApprovalResponse) => void) | null;

function confirmWith(reason: string): void {
  closeApprovalPrompt({ decision: 'confirm', phrase: CONFIRM_PHRASE, reason });
}

// Every gate wears the same heavy rule, so weight alone cannot tell an irreversible one apart —
// and it has to be told apart, because `y` is the primary key on one panel and a refused key on
// the other. The banded warning is the silhouette no other gate has, and it is shape, not hue, so
// it survives a terminal with the colour stripped out.
function IrreversibleRule({ cols }: { cols: number }) {
  const t = useTheme();
  const rule = Math.max(0, approvalTextWidth(cols) - IRREVERSIBLE_NOTE.length - 1);
  return (
    <Box height={1} overflow="hidden">
      <Text color={t.error}>{IRREVERSIBLE_NOTE}</Text>
      <Text color={t.textDim}>{` ${glyph('divider').repeat(rule)}`}</Text>
    </Box>
  );
}

interface ConfirmApprovalPromptProps {
  request: TieredApprovalRequest;
  promptRows: number;
  clampedBoxRows?: number | undefined;
  isActive: boolean;
  graceUntil: number;
  promptIdentity: PromptIdentity;
}

export function ConfirmApprovalPrompt({
  request,
  promptRows,
  clampedBoxRows,
  isActive,
  graceUntil,
  promptIdentity,
}: ConfirmApprovalPromptProps) {
  const [reasonInput, setReasonInput] = useState('');
  const [confirmStep, setConfirmStep] = useState<ConfirmStep>('choose');
  const [nudged, setNudged] = useState(false);
  const reasonInputRef = useRef('');
  const confirmStepRef = useRef<ConfirmStep>('choose');
  const promptIdentityRef = useRef<PromptIdentity>(null);
  const t = useTheme();
  const cols = terminalSizeStore.use((s) => s.cols);
  const rows = terminalSizeStore.use((s) => s.rows);
  const irreversible = isIrreversibleActionClass(request.actionClass);
  const options = getConfirmOptions(request.actionClass);
  const keyWidth = approvalKeyColumnWidth(options);
  const tone = irreversible ? t.error : t.warning;

  if (promptIdentity !== promptIdentityRef.current) {
    promptIdentityRef.current = promptIdentity;
    reasonInputRef.current = '';
    confirmStepRef.current = 'choose';
    setReasonInput('');
    setConfirmStep('choose');
    setNudged(false);
  }

  useInput(
    (input, key) => {
      if (Date.now() < graceUntil) return;
      if (key.escape) {
        closeApprovalPrompt();
        return;
      }

      if (confirmStepRef.current === 'reason') {
        if (key.return) {
          confirmWith(reasonInputRef.current.trim() || CONFIRM_REASON_UNSTATED);
          return;
        }
        if (key.backspace || key.delete) {
          reasonInputRef.current = reasonInputRef.current.slice(0, -1);
          setReasonInput(reasonInputRef.current);
          return;
        }
        if (input && !key.ctrl && !key.meta) {
          reasonInputRef.current += input;
          setReasonInput(reasonInputRef.current);
        }
        return;
      }

      if (key.return) {
        confirmWith(CONFIRM_REASON_UNSTATED);
        return;
      }
      const letter = input.toLowerCase();
      if (letter === 'r') {
        confirmStepRef.current = 'reason';
        setConfirmStep('reason');
        setNudged(false);
        return;
      }
      if (letter === 'x' || letter === 'n') {
        closeApprovalPrompt();
        return;
      }
      if (letter !== 'y') return;
      // A control-plane write costs enter, so `y` here reports the miss instead of
      // silently doing nothing.
      if (irreversible) setNudged(true);
      else confirmWith(CONFIRM_REASON_UNSTATED);
    },
    { isActive },
  );

  useEffect(() => {
    if (!isActive || confirmStep !== 'choose') return;
    const { contentRect } = readConversationScrollSnapshot();
    const boxTop = contentRect.top + contentRect.height;
    const zones = getConfirmOptionZones({
      boxTop,
      cols,
      promptRows: clampedBoxRows ?? promptRows,
      actionClass: request.actionClass,
      actionDescription: request.actionDescription,
    });
    const cleanups = zones.map((zone) =>
      registerMouseZone({
        id: `confirm-option-${zone.key}`,
        left: zone.left,
        right: zone.right,
        top: zone.top,
        bottom: zone.bottom,
        z: PROMPT_ZONE_Z,
        onClick: () => {
          if (zone.key === 'r') {
            confirmStepRef.current = 'reason';
            setConfirmStep('reason');
          } else if (zone.key === 'x') closeApprovalPrompt();
          else confirmWith(CONFIRM_REASON_UNSTATED);
        },
      }),
    );
    return () => {
      for (const cleanup of cleanups) cleanup();
    };
  }, [isActive, confirmStep, cols, rows, promptRows, clampedBoxRows, request]);

  return (
    <Box
      flexDirection="column"
      borderStyle={borderStyleFor('bold')}
      borderColor={irreversible ? t.error : t.border}
      paddingX={1}
      height={promptRows}
      width="100%"
      overflow="hidden"
      flexShrink={0}
    >
      <Text color={t.textDim}>
        {GATE_TITLE}
        {SOFT_SEP}
        <Text color={tone}>{getApprovalSeverityWord(request.actionClass)}</Text>
      </Text>
      <Text> </Text>
      <Text>{getApprovalConfirmLabel(request.actionClass)}</Text>
      <Text bold>{approvalSubjectText(request.actionDescription, cols)}</Text>
      {irreversible ? <IrreversibleRule cols={cols} /> : null}
      <Text> </Text>
      {confirmStep === 'choose' ? (
        <>
          {options.map((option, index) => (
            <Text key={option.key}>
              {index === 0 ? <Text color={t.text}>{cursorGlyph()}</Text> : NO_CURSOR}
              <Text color={t.textDim}>{approvalOptionKeyCell(option, keyWidth)}</Text>
              {'   '}
              {approvalOptionLabelText(option, keyWidth, approvalTextWidth(cols))}
            </Text>
          ))}
          <Box flexGrow={1} minHeight={1} />
          {nudged ? (
            <Text color={t.warning}>{CONFIRM_NUDGE}</Text>
          ) : (
            <Text color={t.textDim}>{getConfirmChooseHints(request.actionClass)}</Text>
          )}
        </>
      ) : (
        <>
          <Text>{CONFIRM_QUESTION}</Text>
          <Box height={1} overflow="hidden">
            <Text color={t.text}>{`${glyph('prompt')} `}</Text>
            <Text wrap="truncate-end">{reasonInput}</Text>
            <Text color={t.text}>{glyph('liveBar')}</Text>
          </Box>
          <Text color={t.textDim}>{CONFIRM_REASON_OPTIONAL}</Text>
          <Box flexGrow={1} minHeight={1} />
          <Text color={t.textDim}>{CONFIRM_REASON_HINTS}</Text>
        </>
      )}
    </Box>
  );
}
