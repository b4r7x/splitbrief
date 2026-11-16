import { ThemeText as Text, useTheme } from '../../../../components/theme.js';
import { Box, useInput } from 'ink';
import { ListViewport } from '../../../../components/pickers/list-viewport.js';
import { RuleHeader } from '../../../../components/rule-header.js';
import { OverlayPanel } from '../../../../components/overlays/panel.js';
import { borderStyleFor, glyph } from '../../../../lib/glyphs.js';
import { listRowLead } from '../../../../components/list-row/lead.js';
import { withMark } from '../prompt-body.js';
import { closeApprovalPrompt } from '../../../../stores/prompts/approval.js';
import { terminalSizeStore } from '../../../../stores/ui/terminal-size.js';
import {
  CONFIRM_QUESTION,
  CONFIRM_REASON_HINTS,
  CONFIRM_REASON_OPTIONAL,
  IRREVERSIBLE_NOTE,
  CHOOSE_HINTS,
  approvalKeyColumnWidth,
  approvalOptionKeyCell,
  approvalOptionLabelText,
  approvalTitle,
  confirmNudge,
  formatApprovalActionDescription,
  getApprovalConfirmLabel,
  getConfirmOptions,
  isIrreversibleActionClass,
  unfocusedPromptLegend,
} from '../../prompt-rows/approval.js';
import { fitConfirmPanel, type ConfirmFrame } from '../../prompt-rows/confirm-panel.js';
import {
  INITIAL_CONFIRM_KEY_STATE,
  confirmKeyStep,
  confirmRowStep,
  type ConfirmKeyResult,
} from '../../prompt-rows/confirm-keys.js';
import type { TieredApprovalRequest } from '../../../../core/approval/types.js';
import { fitKeyLegend } from '../../../../components/key-legend.js';
import { SOFT_SEP } from '../../../../core/separators.js';
import { isCommandDraft } from '../../../../core/composer/submission.js';
import { isBlankDraft } from '../../../../components/composer/use-paste-drafts.js';
import { composerLiveStore } from '../../../../stores/ui/composer-live.js';
import { ELLIPSIS } from '../../../../utils/display-text/truncate.js';
import { countNoun } from '../../../../utils/pluralize.js';
import { useKeyState } from '../../../../hooks/use-key-state.js';

export const PROMPT_ZONE_Z = 50;

interface ConfirmApprovalPromptProps {
  request: TieredApprovalRequest;
  frame: ConfirmFrame;
  promptRows: number;
  clampedBoxRows?: number | undefined;
  isActive: boolean;
  /** False while the composer keeps the keys: the rows show no cursor and no keys. */
  focused: boolean;
  /** True in a phase where the composer's plain words queue for a seat (`isQueuePhase`). */
  queues: boolean;
  graceUntil: number;
}

export function ConfirmApprovalPrompt({
  request,
  frame,
  promptRows,
  clampedBoxRows,
  isActive,
  focused,
  queues,
  graceUntil,
}: ConfirmApprovalPromptProps) {
  const [keys, setKeys, latestKeys] = useKeyState(INITIAL_CONFIRM_KEY_STATE);
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
  // Without the keys the panel says what ⏎ does with the draft below and how to reach its rows.
  // Plain words that no seat takes in this phase stay in the composer, so ⏎ promises nothing.
  const blankDraft = composerLiveStore.use((draft) => isBlankDraft(draft.document));
  const commandDraft = composerLiveStore.use((draft) => isCommandDraft(draft.document));
  const unfocusedLegend = unfocusedPromptLegend({
    blank: blankDraft,
    command: commandDraft,
    words: queues
      ? { long: '⏎ queues the typed correction', short: '⏎ queues the correction' }
      : null,
    width: frame.width,
  });

  const apply = (result: ConfirmKeyResult): void => {
    if (result.kind === 'answer') closeApprovalPrompt(result.answer);
    else setKeys(result.state);
  };

  useInput(
    (input, key) => {
      if (Date.now() < graceUntil) return;
      apply(
        confirmKeyStep(latestKeys(), input, key, {
          actionClass: request.actionClass,
          optionRows: fit.options,
        }),
      );
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
      {keys.step === 'choose' ? (
        <>
          <Box flexDirection="column" flexShrink={0}>
            <ListViewport
              items={[...options]}
              selectedIndex={keys.selectedIndex}
              getKey={(option) => option.key}
              rowBudget={fit.options}
              width={frame.width}
              barColumn="padding"
              rowZonePrefix="confirm-option"
              rowZoneZ={PROMPT_ZONE_Z}
              {...(isActive && {
                onRowActivate: (index: number) => {
                  const option = options[index];
                  if (option !== undefined) apply(confirmRowStep(latestKeys(), option.key));
                },
              })}
              renderItem={(option, ctx) => (
                <Text wrap="truncate-end">
                  <Text color={ctx.isCursor && focused ? t.accent : t.textDim}>
                    {listRowLead(ctx.isCursor && focused ? 'active' : 'default')}
                  </Text>
                  <Text color={t.textDim}>
                    {focused ? approvalOptionKeyCell(option, keyWidth) : ''.padEnd(keyWidth)}
                  </Text>
                  {'   '}
                  <Text color={ctx.isCursor && focused ? t.accent : t.text}>
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
            (keys.nudged ? (
              <Text color={t.warning}>
                {fitKeyLegend(confirmNudge(request.actionClass), frame.width)}
              </Text>
            ) : (
              <Text color={t.textDim}>
                {fitKeyLegend(focused ? CHOOSE_HINTS : unfocusedLegend, frame.width)}
              </Text>
            ))}
        </>
      ) : (
        <>
          {fit.options >= 2 && <Text>{CONFIRM_QUESTION}</Text>}
          <Box height={1} overflow="hidden">
            <Text color={t.text}>{`${glyph('prompt')} `}</Text>
            <Text wrap="truncate-end">{keys.reason}</Text>
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
