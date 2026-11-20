import { PanelSurface } from '../../../../components/overlays/surface.js';
import { ThemeText as Text, useTheme } from '../../../../components/theme.js';
import { Box, useInput } from 'ink';
import { useState } from 'react';
import { ListRows } from '../../../../components/list-row/rows.js';
import { planListRows } from '../../../../components/list-row/plan.js';
import { resolveScrollKey, stepForScrollAction } from '../../../../core/keybindings/scroll.js';
import { APPROVAL_HORIZONTAL_CHROME } from '../../prompt-rows/measure.js';
import { RuleHeader } from '../../../../components/rule-header.js';
import { OverlayPanel } from '../../../../components/overlays/panel.js';
import { borderStyleFor, glyph } from '../../../../lib/glyphs.js';
import { withMark } from '../prompt-body.js';
import { closeApprovalPrompt } from '../../../../stores/prompts/approval.js';
import { terminalSizeStore } from '../../../../stores/ui/terminal-size.js';
import {
  CONFIRM_QUESTION,
  CONFIRM_REASON_HINTS,
  CONFIRM_REASON_OPTIONAL,
  IRREVERSIBLE_NOTE,
  CHOOSE_HINTS,
  approvalTitle,
  confirmNudge,
  getApprovalConfirmLabel,
  getConfirmOptions,
  isIrreversibleActionClass,
} from '../../prompt-rows/approval.js';
import {
  fitConfirmPanel,
  textOfFirstFact,
  type ConfirmFrame,
} from '../../prompt-rows/confirm-panel.js';
import {
  INITIAL_CONFIRM_KEY_STATE,
  confirmKeyStep,
  confirmRowStep,
  type ConfirmKeyResult,
} from '../../prompt-rows/confirm-keys.js';
import type { TieredApprovalRequest } from '../../../../core/approval/types.js';
import { fitKeyLegend } from '../../../../components/key-legend.js';
import { SOFT_SEP } from '../../../../core/separators.js';
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
  /** False while the composer keeps the keys: the rows keep their letters and hide the cursor. */
  focused: boolean;
  /** True in a phase where the composer's plain words queue for a seat (`isQueuePhase`). */
  composerLegend: string;
  onComposerFocus?: (() => void) | undefined;
  graceUntil: number;
}

export function ConfirmApprovalPrompt({
  request,
  frame,
  promptRows,
  clampedBoxRows,
  isActive,
  focused,
  composerLegend,
  onComposerFocus,
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
  const [scrollOffset, setScrollOffset] = useState<number | null>(null);
  const scroll = fit.scroll;
  const page =
    scroll && scrollOffset !== null
      ? scroll.lines.slice(
          Math.min(scrollOffset, scroll.lines.length - scroll.height),
          Math.min(scrollOffset, scroll.lines.length - scroll.height) + scroll.height,
        )
      : null;
  const inlineFacts = fit.subject.length === 0;
  const shownFacts = (inlineFacts ? null : page) ?? fit.subject;
  const tone = irreversible ? t.error : t.warning;
  const title = approvalTitle(request.actionClass);
  const mark = page
    ? 'pgup/pgdn scroll'
    : `${ELLIPSIS} ${countNoun(fit.hidden, 'more line')}${scroll && fit.markRow ? SOFT_SEP + 'pgup/pgdn scroll' : ''}`;
  // One row holds the action and the selected option together, so the panel never asks blind.
  const rowAction = inlineFacts
    ? ((keys.step === 'choose' ? page?.[0] : undefined) ?? textOfFirstFact(request))
    : undefined;
  const lines = planListRows(
    rowAction === undefined
      ? options
      : options.map((option) => ({ ...option, name: option.name + SOFT_SEP + rowAction })),
    { width: frame.width },
  );

  const apply = (result: ConfirmKeyResult): void => {
    if (result.kind === 'answer') closeApprovalPrompt(result.answer);
    else setKeys(result.state);
  };

  useInput(
    (input, key) => {
      if (Date.now() < graceUntil) return;
      if (keys.step === 'choose') {
        if (key.tab && onComposerFocus) {
          onComposerFocus();
          return;
        }
        const action = resolveScrollKey({ input, key, lineKeys: 'none' });
        if (scroll && action) {
          setScrollOffset((previous) =>
            stepForScrollAction({
              action,
              position: previous ?? scroll.start,
              page: scroll.height,
              last: Math.max(0, scroll.lines.length - scroll.height),
            }),
          );
          return;
        }
      }
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
    <PanelSurface
      flexDirection="column"
      {...(fit.framed && {
        borderStyle: borderStyleFor('bold'),
        borderColor: irreversible ? t.error : t.border,
      })}
      // A card pads the panel itself.
      paddingX={fit.framed ? 1 : frame.kind === 'box' ? 2 : 0}
      height={fit.bodyRows}
      width={frame.kind === 'box' ? frame.width + APPROVAL_HORIZONTAL_CHROME : '100%'}
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
      {!page && fit.label && (
        <Text color={t.text}>{getApprovalConfirmLabel(request.actionClass)}</Text>
      )}
      {shownFacts.length > 0 && (
        <Text color={t.text} bold>
          {shownFacts.join('\n')}
        </Text>
      )}
      {fit.hidden > 0 && fit.markRow && <Text color={t.textDim}>{mark}</Text>}
      {/* Every gate wears the same heavy rule, so weight alone cannot tell an irreversible one apart —
          and it has to be told apart, because `y` is the primary key on one panel and a refused key on
          the other. The banded warning is the silhouette no other gate has, and it is shape, not hue, so
          it survives a terminal with the colour stripped out. */}
      {!page && irreversible && fit.note ? (
        <RuleHeader label={IRREVERSIBLE_NOTE} width={frame.width} labelColor={t.error} />
      ) : null}
      {fit.gaps.options && <Text> </Text>}
      {keys.step === 'choose' ? (
        <>
          <Box flexDirection="column" flexShrink={0}>
            <ListRows
              lines={lines}
              focused={focused && isActive}
              selectedIndex={keys.selectedIndex}
              getKey={(i) => options[i]?.key ?? ''}
              rowBudget={fit.options}
              width={frame.width}
              rowZonePrefix="confirm-option"
              rowZoneZ={PROMPT_ZONE_Z}
              onActivate={
                isActive
                  ? (index) => {
                      const option = options[index];
                      if (option) apply(confirmRowStep(latestKeys(), option.key));
                    }
                  : undefined
              }
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
                {fitKeyLegend(focused ? CHOOSE_HINTS : composerLegend, frame.width)}
              </Text>
            ))}
        </>
      ) : (
        <>
          {fit.options >= 2 && <Text color={t.text}>{CONFIRM_QUESTION}</Text>}
          <Box height={1} overflow="hidden">
            <Text color={t.text}>{`${glyph('prompt')} `}</Text>
            <Text color={t.text} wrap="truncate-end">
              {keys.reason}
            </Text>
            <Text color={t.text}>{glyph('liveBar')}</Text>
            {rowAction !== undefined && <Text color={t.textDim}>{`${SOFT_SEP}${rowAction}`}</Text>}
          </Box>
          {fit.options >= 3 && <Text color={t.textDim}>{CONFIRM_REASON_OPTIONAL}</Text>}
          <Box flexGrow={1} minHeight={fit.gaps.legend ? 1 : 0} />
          {fit.legend && <Text color={t.textDim}>{CONFIRM_REASON_HINTS}</Text>}
        </>
      )}
    </PanelSurface>
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
