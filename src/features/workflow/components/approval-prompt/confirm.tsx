import { ThemeText as Text, useTheme } from '../../../../components/theme.js';
import { useRef, useState } from 'react';
import { Box, useInput } from 'ink';
import { ListViewport } from '../../../../components/pickers/list-viewport.js';
import { isItemIndexVisible } from '../../../../components/pickers/scroll-window.js';
import { RuleHeader } from '../../../../components/rule-header.js';
import { OverlayPanel } from '../../../../components/overlays/overlay-panel.js';
import { borderStyleFor, glyph } from '../../../../lib/glyphs.js';
import { listRowLead } from '../../../../components/list-row.js';
import { withMark } from '../prompt-body.js';
import { closeApprovalPrompt } from '../../../../stores/approval-prompt/prompt.js';
import { terminalSizeStore } from '../../../../stores/ui/terminal-size.js';
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
  formatApprovalActionDescription,
  getApprovalConfirmLabel,
  getConfirmOptions,
  isIrreversibleActionClass,
  type ConfirmFrame,
} from '../../prompt-rows/approval.js';
import { CONFIRM_PHRASE } from '../../../../core/approval/types.js';
import type { TieredApprovalRequest } from '../../../../core/approval/types.js';
import { navigateIndex } from '../../../../utils/indexing.js';
import { fitKeyLegend } from '../../../../core/key-legend.js';
import { SOFT_SEP } from '../../../../core/separators.js';
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
  frame: ConfirmFrame;
  promptRows: number;
  clampedBoxRows?: number | undefined;
  isActive: boolean;
  graceUntil: number;
}

export function ConfirmApprovalPrompt({
  request,
  frame,
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
  const rows = terminalSizeStore.use((s) => s.rows);
  // A page that gives the panel no region gives it the terminal.
  const boxRows = Math.min(promptRows, clampedBoxRows ?? rows);
  const fit = fitConfirmPanel({
    actionClass: request.actionClass,
    actionDescription: request.actionDescription,
    frame,
    boxRows,
  });
  const irreversible = isIrreversibleActionClass(request.actionClass);
  const options = getConfirmOptions(request.actionClass);
  const keyWidth = approvalKeyColumnWidth(options);
  const tone = irreversible ? t.error : t.warning;
  const title = approvalTitle(request.actionClass);
  const mark = `${ELLIPSIS} ${countNoun(fit.hidden, 'more line')}`;
  // One row holds the action and the selected option together, so the panel never asks blind.
  const rowAction =
    fit.subject.length === 0
      ? formatApprovalActionDescription(request.actionDescription).split('\n')[0]
      : undefined;

  const moveTo = (index: number): void => {
    selectedIndexRef.current = index;
    setSelectedIndex(index);
  };

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
        if (option !== undefined && fit.options > 0) takeRow(option.key);
        return;
      }

      const letter = input.toLowerCase();
      const letterRow = options.findIndex((option) => option.key === letter);
      const inView = isItemIndexVisible({
        items: [...options],
        selectedIndex: selectedIndexRef.current,
        itemIndex: letter === 'r' ? letterRow : 0,
        rowBudget: fit.options,
      });
      if (letter === 'r' && letterRow >= 0) {
        if (inView) takeRow('r');
        else moveTo(letterRow);
        return;
      }
      if (letter === 'x' || letter === 'n') {
        deny();
        return;
      }
      if (letter !== 'y') return;
      // A control-plane write costs the highlighted row, so `y` moves the highlight back to
      // Confirm and reports the miss instead of silently doing nothing.
      if (irreversible || !inView) {
        moveTo(0);
        setNudged(true);
      } else {
        confirmWith(CONFIRM_REASON_UNSTATED);
      }
    },
    { isActive },
  );

  const body = (
    <Box
      flexDirection="column"
      {...(fit.framed && {
        borderStyle: borderStyleFor('bold'),
        borderColor: irreversible ? t.error : t.border,
      })}
      // A card pads the panel itself.
      paddingX={fit.framed ? 1 : frame.kind === 'box' ? 2 : 0}
      height={fit.bodyRows}
      width="100%"
      overflow="hidden"
      flexShrink={0}
    >
      {fit.title &&
        (fit.hidden > 0 && !fit.markRow ? (
          withMark(
            <Text wrap="truncate" color={tone}>
              {title}
            </Text>,
            mark,
            'title',
            t,
          )
        ) : (
          <Text color={tone}>{title}</Text>
        ))}
      {fit.gaps.title && <Text> </Text>}
      {fit.label && <Text>{getApprovalConfirmLabel(request.actionClass)}</Text>}
      {fit.subject.length > 0 && <Text bold>{fit.subject.join('\n')}</Text>}
      {fit.hidden > 0 && fit.markRow && <Text color={t.textDim}>{mark}</Text>}
      {/* Every gate wears the same heavy rule, so weight alone cannot tell an irreversible one apart —
          and it has to be told apart, because `y` is the primary key on one panel and a refused key on
          the other. The banded warning is the silhouette no other gate has, and it is shape, not hue, so
          it survives a terminal with the colour stripped out. */}
      {irreversible && fit.note ? (
        <RuleHeader label={IRREVERSIBLE_NOTE} width={frame.width} labelColor={t.error} />
      ) : null}
      {fit.gaps.options && <Text> </Text>}
      {confirmStep === 'choose' ? (
        <>
          <Box flexDirection="column" flexShrink={0}>
            <ListViewport
              items={[...options]}
              selectedIndex={selectedIndex}
              getKey={(option) => option.key}
              rowBudget={fit.options}
              width={frame.width}
              barColumn="padding"
              rowZonePrefix="confirm-option"
              rowZoneZ={PROMPT_ZONE_Z}
              {...(isActive && {
                onRowActivate: (index: number) => {
                  const option = options[index];
                  if (option !== undefined) takeRow(option.key);
                },
              })}
              renderItem={(option, ctx) => (
                <Text wrap="truncate-end">
                  <Text color={ctx.isCursor ? t.accent : t.textDim}>
                    {listRowLead(ctx.isCursor ? 'active' : 'default')}
                  </Text>
                  <Text color={t.textDim}>{approvalOptionKeyCell(option, keyWidth)}</Text>
                  {'   '}
                  <Text color={ctx.isCursor ? t.accent : t.text}>
                    {approvalOptionLabelText({ option, keyWidth, width: frame.width })}
                  </Text>
                  {rowAction !== undefined && (
                    <Text color={t.text}>{`${SOFT_SEP}${rowAction}`}</Text>
                  )}
                </Text>
              )}
            />
          </Box>
          <Box flexGrow={1} minHeight={fit.gaps.legend ? 1 : 0} />
          {fit.legend &&
            (nudged ? (
              <Text color={t.warning}>{fitKeyLegend(CONFIRM_NUDGE, frame.width)}</Text>
            ) : (
              <Text color={t.textDim}>{fitKeyLegend(CHOOSE_HINTS, frame.width)}</Text>
            ))}
        </>
      ) : (
        <>
          {fit.options >= 2 && <Text>{CONFIRM_QUESTION}</Text>}
          <Box height={1} overflow="hidden">
            <Text color={t.text}>{`${glyph('prompt')} `}</Text>
            <Text wrap="truncate-end">{reasonInput}</Text>
            <Text color={t.text}>{glyph('liveBar')}</Text>
            {rowAction !== undefined && <Text color={t.textDim}>{`${SOFT_SEP}${rowAction}`}</Text>}
          </Box>
          {fit.options >= 3 && <Text color={t.textDim}>{CONFIRM_REASON_OPTIONAL}</Text>}
          <Box flexGrow={1} minHeight={fit.gaps.legend ? 1 : 0} />
          {fit.legend && <Text color={t.textDim}>{CONFIRM_REASON_HINTS}</Text>}
        </>
      )}
    </Box>
  );
  return frame.kind === 'box' ? (
    body
  ) : (
    <OverlayPanel
      title={frame.card.title}
      density={frame.card.density}
      paddingY={fit.card.padding ? 1 : 0}
      titleSpacing={fit.card.titleGap ? 'gap' : 'tight'}
    >
      {body}
    </OverlayPanel>
  );
}
