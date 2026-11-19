import { PanelRow } from '../../../components/overlays/row.js';
import { PanelSurface } from '../../../components/overlays/surface.js';
import { ThemeText as Text, useTheme } from '../../../components/theme.js';
import { useLayoutEffect, useState } from 'react';
import { Box, useInput } from 'ink';
import { questionOptions, questionPromptStore } from '../../../stores/prompts/question.js';
import {
  decideRowIndex,
  fitQuestionText,
  fitQuestionView,
  followQuestionSelection,
  questionMenu,
} from '../prompt-rows/question.js';
import { MultilineInput } from '../../../components/input/field.js';
import { borderStyleFor } from '../../../lib/glyphs.js';
import { listRowLead } from '../../../components/list-row/lead.js';
import { formatKeyHints, SELECT_HINT } from '../../../components/key-legend.js';
import { fitKeyLegend } from '../../../components/key-legend.js';
import { SOFT_SEP } from '../../../core/separators.js';
import { PROMPT_TYPEAHEAD_GRACE_MS } from '../../../lib/terminal/typeahead-grace.js';
import { clamp } from '../../../utils/math.js';

export function PlannerQuestion({
  width,
  height,
  disabled,
  onAnswer,
  onCompose,
  onDecide,
  onPrevious,
}: {
  width: number;
  height: number;
  disabled: boolean;
  onAnswer: (answer: string) => void;
  onCompose: () => void;
  onDecide: () => void;
  onPrevious: () => void;
}) {
  const state = questionPromptStore.use((value) => value);
  const t = useTheme();
  const [offset, setOffset] = useState(0);
  const question = state.questions?.[state.index];
  const selected = state.drafts[state.index]?.selected ?? 0;
  const focused = state.focus === 'menu';
  const writing = state.focus === 'answer';
  const view = fitQuestionView({
    question,
    index: state.index,
    selected,
    width,
    height,
    writing,
    offset,
  });
  const {
    innerWidth,
    chrome,
    showAnswer,
    answerRows,
    bodyHeight,
    maxOffset,
    visibleOffset,
    first,
    last,
  } = view;

  useLayoutEffect(() => {
    setOffset((current) =>
      followQuestionSelection(current, { first, last, bodyHeight, maxOffset, writing }),
    );
    // Manual page scrolling must not snap back to the selected option on unrelated renders.
  }, [first, last, bodyHeight, maxOffset, state.index, state.openedAt, writing]);

  useInput(
    (_input, key) => {
      const current = questionPromptStore.get();
      if (
        current.focus === 'composer' ||
        current.complete ||
        Date.now() - current.openedAt < PROMPT_TYPEAHEAD_GRACE_MS
      )
        return;
      if (key.pageUp || key.pageDown) {
        setOffset((value) =>
          clamp(value + (key.pageDown ? bodyHeight : -bodyHeight), 0, maxOffset),
        );
        return;
      }
      // shift+↑/↓ scrolls the transcript; Ink reports it as an arrow to every active handler.
      if (key.shift && (key.upArrow || key.downArrow)) return;
      // The answer field can change focus during this same key dispatch.
      if (!focused || current.focus !== 'menu') return;
      const active = current.questions?.[current.index];
      if (!active) return;
      const menu = questionMenu(active, current.index);
      const selection = current.drafts[current.index]?.selected ?? 0;
      if (key.tab) onCompose();
      else if (key.downArrow && selection === menu.length - 1)
        questionPromptStore.setFocus('composer');
      else if (key.upArrow || key.downArrow)
        questionPromptStore.select(clamp(selection + (key.downArrow ? 1 : -1), 0, menu.length - 1));
      else if (key.home) setOffset(0);
      else if (key.end) setOffset(maxOffset);
      else if (key.return && (first < visibleOffset || first >= visibleOffset + bodyHeight))
        setOffset(first);
      else if (key.return) {
        const count = questionOptions(active).length;
        if (selection === decideRowIndex(active)) onDecide();
        else if (count > 0 && selection === count) onCompose();
        else if (selection >= count) onPrevious();
        else {
          const answer = menu[selection];
          if (answer !== undefined) onAnswer(answer);
        }
      }
    },
    { isActive: (focused || writing) && !disabled },
  );

  if (!question) return null;
  const { mark, asked, body, answerWidth, besideQuestion } = fitQuestionText(
    view,
    state.drafts[state.index]?.text ?? '',
  );
  const finalQuestion = state.index === (state.questions?.length ?? 0) - 1;
  const next = finalQuestion ? 'send answers' : 'next';
  const reply = { key: 'esc', verb: 'type a reply' };
  const legend = focused
    ? fitKeyLegend(
        formatKeyHints([
          SELECT_HINT,
          { key: '⏎', verb: next },
          reply,
          { key: 'tab', verb: 'write' },
        ]),
        innerWidth,
      )
    : writing
      ? fitKeyLegend(
          formatKeyHints([
            { key: '⏎', verb: next },
            { key: '↑/tab', verb: 'menu' },
            reply,
            { key: '↓', verb: 'instruction' },
          ]),
          innerWidth,
        )
      : 'Questions paused · tab to return · esc type a reply';
  return (
    <PanelSurface
      width={width}
      height={height}
      flexDirection="column"
      {...(chrome.framed && {
        borderStyle: borderStyleFor('single'),
        borderColor: focused || writing ? t.accent : t.border,
      })}
      paddingX={chrome.framed ? 1 : 2}
      flexShrink={0}
      overflow="hidden"
    >
      {chrome.titled && (
        <Text color={t.textDim} wrap="truncate-end">
          Question {state.index + 1} of {state.questions?.length}
          {asked}
        </Text>
      )}
      <Box height={bodyHeight} flexDirection="column" flexShrink={0} overflow="hidden">
        {body.map(({ row, text }, index) => (
          <PanelRow
            key={visibleOffset + index}
            active={row.option === selected && focused && !disabled}
          >
            <Text
              color={
                row.option === selected && focused ? t.accent : row.navigation ? t.textDim : t.text
              }
              bold={row.option === undefined && row.text !== ''}
              wrap="truncate-end"
            >
              {row.option === undefined
                ? ''
                : listRowLead(
                    focused && row.first && row.option === selected ? 'active' : 'default',
                  )}
              {text || (row.defaultLabel ? '' : ' ')}
              {row.defaultLabel && (
                <Text color={t.textDim} bold={false}>
                  {' '}
                  {row.defaultLabel}
                </Text>
              )}
              {!chrome.titled && (
                <Text color={t.textDim} bold={false}>
                  {asked}
                </Text>
              )}
            </Text>
          </PanelRow>
        ))}
      </Box>
      {showAnswer && (
        <Box height={answerRows} flexShrink={0}>
          <Text color={writing ? t.accent : t.textDim}>› </Text>
          <Box width={answerWidth} flexDirection="column">
            <MultilineInput
              resetKey={state.index}
              value={state.drafts[state.index]?.text ?? ''}
              textStyle={{ color: t.text }}
              onChange={(text) => questionPromptStore.setFocus('answer', text)}
              onSubmit={onAnswer}
              placeholder="Your answer…"
              columns={answerWidth}
              rows={answerRows}
              maxRows={answerRows}
              focus={writing && !disabled}
              isActive={writing && !disabled}
              keyBindings={{
                submit: (key) => key.return && !key.shift,
                newline: (key) => key.return && key.shift,
              }}
              shouldHandleInput={(_input, key) => {
                if (Date.now() - questionPromptStore.get().openedAt < PROMPT_TYPEAHEAD_GRACE_MS)
                  return false;
                if (!key.tab) return true;
                questionPromptStore.setFocus('menu');
                return false;
              }}
              onBoundaryNavigate={(direction) => {
                if (direction === 'down') {
                  questionPromptStore.setFocus('composer');
                  return;
                }
                questionPromptStore.setFocus('menu');
              }}
            />
          </Box>
          {besideQuestion !== '' && (
            <Text color={t.textDim} wrap="truncate-end">
              {besideQuestion}
            </Text>
          )}
        </Box>
      )}
      {chrome.extraRows > 0 && (
        <Text color={t.textDim}>{maxOffset > 0 ? `${mark}${SOFT_SEP}pgup/pgdn scroll` : ' '}</Text>
      )}
      {chrome.legend && <Text color={t.textDim}>{legend}</Text>}
    </PanelSurface>
  );
}
