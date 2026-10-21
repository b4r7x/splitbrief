import { ThemeText as Text, useTheme } from '../../../../components/theme.js';
import { useEffect, useRef, useState } from 'react';
import { Box, useInput } from 'ink';
import { RuleHeader } from '../../../../components/rule-header.js';
import { borderStyleFor, glyph } from '../../../../lib/glyphs.js';
import { listRowLead } from '../../../../components/list-row.js';
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
  IRREVERSIBLE_NOTE,
  CHOOSE_HINTS,
  approvalKeyColumnWidth,
  approvalOptionKeyCell,
  approvalOptionLabelText,
  approvalTitle,
  fitConfirmPanel,
  getApprovalConfirmLabel,
  getConfirmOptionZones,
  getConfirmOptions,
  isIrreversibleActionClass,
} from '../../prompt-rows/approval.js';
import { CONFIRM_PHRASE } from '../../../../core/approval/types.js';
import type { TieredApprovalRequest } from '../../../../core/approval/types.js';
import { approvalTextWidth } from '../../prompt-rows/measure.js';
import { navigateIndex } from '../../../../utils/indexing.js';
import { fitKeyLegend } from '../../../../core/key-legend.js';
import { ELLIPSIS } from '../../../../utils/display-text.js';
import { countNoun } from '../../../../utils/pluralize.js';

export const PROMPT_ZONE_Z = 50;

type ConfirmStep = 'choose' | 'reason';

function confirmWith(reason: string): void {
  closeApprovalPrompt({ decision: 'confirm', phrase: CONFIRM_PHRASE, reason });
}

// An answer, unlike a prompt closed by a stop: the engine reads `user_cancelled` as the stop.
function deny(): void {
  closeApprovalPrompt({ decision: 'deny', reason: 'user_denied' });
}

interface ConfirmApprovalPromptProps {
  request: TieredApprovalRequest;
  promptRows: number;
  clampedBoxRows?: number | undefined;
  isActive: boolean;
  graceUntil: number;
}

export function ConfirmApprovalPrompt({
  request,
  promptRows,
  clampedBoxRows,
  isActive,
  graceUntil,
}: ConfirmApprovalPromptProps) {
  const [reasonInput, setReasonInput] = useState('');
  const [confirmStep, setConfirmStep] = useState<ConfirmStep>('choose');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [nudged, setNudged] = useState(false);
  const reasonInputRef = useRef('');
  const confirmStepRef = useRef<ConfirmStep>('choose');
  const selectedIndexRef = useRef(0);
  const t = useTheme();
  const cols = terminalSizeStore.use((s) => s.cols);
  const rows = terminalSizeStore.use((s) => s.rows);
  // A page that gives the panel no region gives it the terminal.
  const boxRows = Math.min(promptRows, clampedBoxRows ?? rows);
  const fit = fitConfirmPanel({
    actionDescription: request.actionDescription,
    cols,
    promptRows,
    boxRows,
  });
  const irreversible = isIrreversibleActionClass(request.actionClass);
  const options = getConfirmOptions(request.actionClass);
  const keyWidth = approvalKeyColumnWidth(options);
  const tone = irreversible ? t.error : t.warning;

  const takeRow = (key: string): void => {
    if (key === 'r') {
      confirmStepRef.current = 'reason';
      setConfirmStep('reason');
      setNudged(false);
      return;
    }
    if (key === 'x') {
      deny();
      return;
    }
    confirmWith(CONFIRM_REASON_UNSTATED);
  };

  useInput(
    (input, key) => {
      if (Date.now() < graceUntil) return;
      if (key.escape) {
        deny();
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

      if (key.upArrow || key.downArrow) {
        selectedIndexRef.current = navigateIndex(
          key.upArrow ? 'up' : 'down',
          selectedIndexRef.current,
          options.length,
        );
        setSelectedIndex(selectedIndexRef.current);
        setNudged(false);
        return;
      }
      if (key.return) {
        const option = options[selectedIndexRef.current];
        if (option !== undefined) takeRow(option.key);
        return;
      }

      const letter = input.toLowerCase();
      if (letter === 'r') {
        takeRow('r');
        return;
      }
      if (letter === 'x' || letter === 'n') {
        deny();
        return;
      }
      if (letter !== 'y') return;
      // A control-plane write costs the highlighted row, so `y` moves the highlight back to
      // Confirm and reports the miss instead of silently doing nothing.
      if (irreversible) {
        selectedIndexRef.current = 0;
        setSelectedIndex(0);
        setNudged(true);
      } else {
        confirmWith(CONFIRM_REASON_UNSTATED);
      }
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
      promptRows,
      boxRows,
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
        onClick: () => takeRow(zone.key),
      }),
    );
    return () => {
      for (const cleanup of cleanups) cleanup();
    };
  }, [isActive, confirmStep, cols, rows, promptRows, boxRows, request]);

  return (
    <Box
      flexDirection="column"
      borderStyle={borderStyleFor('bold')}
      borderColor={irreversible ? t.error : t.border}
      paddingX={1}
      height={boxRows}
      width="100%"
      overflow="hidden"
      flexShrink={0}
    >
      <Text color={tone}>{approvalTitle(request.actionClass)}</Text>
      {fit.gaps.title && <Text> </Text>}
      <Text>{getApprovalConfirmLabel(request.actionClass)}</Text>
      <Text bold>{fit.subject.join('\n')}</Text>
      {fit.hidden > 0 && (
        <Text color={t.textDim}>{`${ELLIPSIS} ${countNoun(fit.hidden, 'more line')}`}</Text>
      )}
      {/* Every gate wears the same heavy rule, so weight alone cannot tell an irreversible one apart —
          and it has to be told apart, because `y` is the primary key on one panel and a refused key on
          the other. The banded warning is the silhouette no other gate has, and it is shape, not hue, so
          it survives a terminal with the colour stripped out. */}
      {irreversible ? (
        <RuleHeader
          label={IRREVERSIBLE_NOTE}
          width={approvalTextWidth(cols)}
          labelColor={t.error}
        />
      ) : null}
      {fit.gaps.options && <Text> </Text>}
      {confirmStep === 'choose' ? (
        <>
          {options.map((option, index) => {
            const active = index === selectedIndex;
            return (
              <Text key={option.key}>
                <Text color={active ? t.accent : t.textDim}>
                  {listRowLead(active ? 'active' : 'default')}
                </Text>
                <Text color={t.textDim}>{approvalOptionKeyCell(option, keyWidth)}</Text>
                {'   '}
                <Text color={active ? t.accent : t.text}>
                  {approvalOptionLabelText({ option, keyWidth, width: approvalTextWidth(cols) })}
                </Text>
              </Text>
            );
          })}
          <Box flexGrow={1} minHeight={fit.gaps.legend ? 1 : 0} />
          {nudged ? (
            <Text color={t.warning}>{fitKeyLegend(CONFIRM_NUDGE, approvalTextWidth(cols))}</Text>
          ) : (
            <Text color={t.textDim}>{fitKeyLegend(CHOOSE_HINTS, approvalTextWidth(cols))}</Text>
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
          <Box flexGrow={1} minHeight={fit.gaps.legend ? 1 : 0} />
          <Text color={t.textDim}>{CONFIRM_REASON_HINTS}</Text>
        </>
      )}
    </Box>
  );
}
