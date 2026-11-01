import { segmentsForRowText } from '../../../utils/display-text.js';
import { ThemeText as Text, useTheme } from '../../../components/theme.js';
import { Box, useInput } from 'ink';
import { borderStyleFor } from '../../../lib/glyphs.js';
import { fitKeyLegend } from '../../../core/key-legend.js';
import { useStaticSelector } from '../../../hooks/use-static-selector.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { stopMenuChrome, stopMenuLayout } from '../stop/options.js';
import { MenuRows } from '../stop/menu-rows.js';
import { slashHandoffPending } from '../slash-handoff.js';
import { TextSpans } from '../../../components/text-spans.js';
import {
  RESULT_MENU_LEGEND,
  RESULT_MENU_UNFOCUSED_LEGEND,
  resultMenuFindingLines,
  resultMenuHeight,
  resultMenuNoteLines,
  resultMenuRows,
  resultMenuTitle,
  resultRowCommand,
  type ResultRow,
} from './options.js';

export interface ResultMenuProps {
  override: boolean;
  findings: readonly string[];
  note?: string | undefined;
  files: number | null;
  focused: boolean;
  confirming: boolean;
  height?: number | undefined;
  onConfirmingChange: (confirming: boolean) => void;
  onFocusChange: (menuFocused: boolean) => void;
  onCommand: (raw: string) => void;
  onShowDiff: () => void;
}

export function ResultMenu(props: ResultMenuProps) {
  return <ResultMenuBody key={props.confirming ? 'confirm' : 'menu'} {...props} />;
}

function ResultMenuBody({
  override,
  findings,
  note,
  files,
  focused,
  height,
  confirming,
  onConfirmingChange,
  onFocusChange,
  onCommand,
  onShowDiff,
}: ResultMenuProps) {
  const t = useTheme();
  const cols = terminalSizeStore.use((state) => state.cols);
  const input = { override, findings, note, confirming, files };
  const rows = resultMenuRows(input);
  const layout = stopMenuLayout(rows, cols);
  const boxHeight = height ?? resultMenuHeight(input, cols);
  const chrome = stopMenuChrome(boxHeight, layout.bodyRows);

  const { selectedIndex } = useStaticSelector<ResultRow>({
    items: rows,
    isActive: focused,
    keyOf: (row) => row.id,
    shouldHandleInput: () => !slashHandoffPending(),
    isIndexActionable: () => chrome.listRows > 0,
    onSelect: (row) => {
      if (row.id === 'apply' && override) {
        onConfirmingChange(true);
        return;
      }
      if (row.id === 'back') {
        onConfirmingChange(false);
        return;
      }
      if (row.id === 'show-diff') {
        onShowDiff();
        return;
      }
      const command = resultRowCommand(row.id);
      if (command !== null) onCommand(command);
      if (row.id === 'confirm-apply') onConfirmingChange(false);
    },
  });

  useInput(
    (_input, key) => {
      if (key.tab) onFocusChange(false);
    },
    { isActive: focused },
  );

  const legend = fitKeyLegend(
    focused ? RESULT_MENU_LEGEND : RESULT_MENU_UNFOCUSED_LEGEND,
    Math.max(1, layout.width - 4),
  );
  // The findings take up to half of the rows the chrome leaves, and the note the other rows; a note
  // taller than that ends on an ellipsis.
  const bodyRows = chrome.extraRows;
  const noteRows = Math.max(
    Math.min(1, bodyRows),
    bodyRows - Math.min(findings.length, Math.ceil(bodyRows / 2)),
  );
  const wrappedNote = confirming && noteRows > 0 ? resultMenuNoteLines(note, cols) : [];
  const noteLines =
    wrappedNote.length <= noteRows
      ? wrappedNote
      : [...wrappedNote.slice(0, noteRows - 1), `${wrappedNote[noteRows - 1]}…`];
  const findingLines = confirming
    ? [...noteLines, ...resultMenuFindingLines(findings, bodyRows - noteLines.length)]
    : [];
  const titleParts = resultMenuTitle(input);
  const title = fitKeyLegend(
    titleParts.map((part) => part.text).join(''),
    Math.max(1, layout.width - 4),
  );
  return (
    <Box
      width={layout.width}
      height={boxHeight}
      {...(chrome.framed && {
        borderStyle: borderStyleFor('single'),
        borderColor: focused ? t.accent : t.border,
        borderDimColor: !focused,
      })}
      paddingX={chrome.framed ? 1 : 2}
      flexDirection="column"
      overflow="hidden"
      flexShrink={0}
    >
      {chrome.titled && (
        <Text color={t.textDim} wrap="truncate-end">
          <TextSpans parts={segmentsForRowText(titleParts, title)} />
        </Text>
      )}
      {findingLines.map((line, index) => (
        <Text key={index} color={t.text} wrap="truncate-end">
          {line}
        </Text>
      ))}
      <Box height={chrome.listRows} flexDirection="column" flexShrink={0}>
        {/* The mark follows the keyboard: while the composer holds it, ⏎ answers no row. */}
        <MenuRows
          options={layout.options}
          selectedIndex={selectedIndex}
          marked={focused}
          rowBudget={chrome.listRows}
          width={layout.width - 4}
        />
      </Box>
      {chrome.legend && <Text color={t.textDim}>{legend}</Text>}
    </Box>
  );
}
