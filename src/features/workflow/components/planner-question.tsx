import { ThemeText as Text, useTheme } from '../../../components/theme.js';
import { useLayoutEffect, useState } from 'react';
import { Box, useInput } from 'ink';
import { questionOptions, questionPromptStore } from '../../../stores/question-prompt/prompt.js';
import {
  decideRowIndex,
  questionMenu,
  questionRows,
  QUESTION_ANSWER_ROWS,
} from '../prompt-rows/question.js';
import { MultilineInput } from '../../../components/input/multiline-input.js';
import { borderStyleFor } from '../../../lib/glyphs.js';
import { listRowLead } from '../../../components/list-row.js';
import { formatKeyHints, SELECT_HINT } from '../prompt-rows/approval.js';
import { fitKeyLegend } from '../../../core/key-legend.js';
import { SOFT_SEP } from '../../../core/separators.js';
import { PROMPT_TYPEAHEAD_GRACE_MS } from '../../../lib/terminal/typeahead-grace.js';
import { truncateTerminalDisplayText } from '../../../utils/display-text.js';
import { clamp } from '../../../utils/math.js';
import { stopMenuChrome } from '../stop/options.js';

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
  const choices = question ? questionOptions(question) : [];
  const showAnswer = writing || (choices.length === 0 && height > QUESTION_ANSWER_ROWS);
  const answerRows = showAnswer ? QUESTION_ANSWER_ROWS : 0;
  const innerWidth = Math.max(1, width - 4);
  const rows = question ? questionRows(question, state.index, innerWidth) : [];
  const chrome = stopMenuChrome(height, 1 + answerRows);
  const bodyHeight = Math.max(chrome.extraRows, chrome.listRows - answerRows);
  const maxOffset = Math.max(0, rows.length - bodyHeight);
  const visibleOffset = clamp(offset, 0, maxOffset);

  const first = rows.findIndex((row) => row.option === selected);
  const last = rows.findLastIndex((row) => row.option === selected);
  useLayoutEffect(() => {
    setOffset((current) => {
      if (writing) return 0;
      if (first < current) return Math.max(0, first);
      if (last >= current + bodyHeight)
        return clamp(last - first >= bodyHeight ? first : last - bodyHeight + 1, 0, maxOffset);
      return clamp(current, 0, maxOffset);
    });
    // The answer field shows the question from its first row; manual page scrolling must
    // not snap back to the selected option on unrelated renders.
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
  const asked = visibleOffset > 0 ? `${SOFT_SEP}${rows[0]?.text}` : '';
  // One row holds the option and the question together, so a long option leaves the question half.
  const rowText = (text: string): string =>
    chrome.titled || asked === ''
      ? text
      : truncateTerminalDisplayText(text.trimEnd(), Math.ceil(innerWidth / 2));
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
    <Box
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
        {rows.slice(visibleOffset, visibleOffset + bodyHeight).map((row, index) => (
          <Text
            key={visibleOffset + index}
            color={
              row.option === selected && focused ? t.accent : row.navigation ? t.textDim : t.text
            }
            bold={row.option === undefined && row.text !== ''}
            wrap="truncate-end"
          >
            {row.option === undefined
              ? ''
              : listRowLead(focused && row.first && row.option === selected ? 'active' : 'default')}
            {rowText(row.text) || (row.defaultLabel ? '' : ' ')}
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
        ))}
      </Box>
      {showAnswer && (
        <Box height={QUESTION_ANSWER_ROWS} flexShrink={0}>
          <Text color={writing ? t.accent : t.textDim}>› </Text>
          <Box width={Math.max(1, innerWidth - 2)} flexDirection="column">
            <MultilineInput
              key={state.index}
              value={state.drafts[state.index]?.text ?? ''}
              onChange={(text) => questionPromptStore.setFocus('answer', text)}
              onSubmit={onAnswer}
              placeholder="Your answer…"
              columns={Math.max(1, innerWidth - 2)}
              rows={QUESTION_ANSWER_ROWS}
              maxRows={QUESTION_ANSWER_ROWS}
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
                  return true;
                }
                questionPromptStore.setFocus('menu');
                return true;
              }}
            />
          </Box>
        </Box>
      )}
      {chrome.extraRows > 0 && (
        <Text color={t.textDim}>
          {maxOffset > 0
            ? `${visibleOffset > 0 ? '↑ more · ' : ''}${visibleOffset < maxOffset ? '↓ more · ' : ''}pgup/pgdn scroll`
            : ' '}
        </Text>
      )}
      {chrome.legend && <Text color={t.textDim}>{legend}</Text>}
    </Box>
  );
}
