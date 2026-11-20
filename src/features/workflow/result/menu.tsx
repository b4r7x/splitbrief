import { segmentsForRowText } from '../../../utils/display-text/width.js';
import { ThemeText as Text, useTheme } from '../../../components/theme.js';
import { Box } from 'ink';
import { fitKeyLegend } from '../../../components/key-legend.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { inlineMenuChrome, inlineMenuLayout } from '../inline-menu/layout.js';
import { InlineMenuPanel } from '../inline-menu/panel.js';
import { useInlineMenuKeys } from '../inline-menu/use-keys.js';
import { ListRows } from '../../../components/list-row/rows.js';
import { TextSpans } from '../../../components/text-spans.js';
import {
  RESULT_MENU_LEGEND,
  RESULT_MENU_UNFOCUSED_LEGEND,
  resultMenuHeight,
  resultMenuOpenLines,
  resultMenuRows,
  resultMenuTitle,
  resultRowCommand,
  type ResultMenuInput,
  type ResultRow,
} from './options.js';

export interface ResultMenuProps {
  override: boolean;
  findings: readonly string[];
  redChecks?: ResultMenuInput['redChecks'];
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
  redChecks,
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
  const input = { override, findings, redChecks, confirming, files };
  const rows = resultMenuRows(input);
  const layout = inlineMenuLayout(rows, cols);
  const boxHeight = height ?? resultMenuHeight(input, cols);
  const chrome = inlineMenuChrome(boxHeight, layout.bodyRows);

  const selectedIndex = useInlineMenuKeys<ResultRow>({
    items: rows,
    keyOf: (row) => row.id,
    focused,
    listRows: chrome.listRows,
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
    onTab: () => onFocusChange(false),
  });

  const legend = focused ? RESULT_MENU_LEGEND : RESULT_MENU_UNFOCUSED_LEGEND;
  const bodyLines = confirming ? resultMenuOpenLines(input, chrome.extraRows) : [];
  const titleParts = resultMenuTitle(input);
  const title = fitKeyLegend(
    titleParts.map((part) => part.text).join(''),
    Math.max(1, layout.width - 4),
  );
  return (
    <InlineMenuPanel
      width={layout.width}
      height={boxHeight}
      framed={chrome.framed}
      focused={focused}
      title={
        chrome.titled ? <TextSpans parts={segmentsForRowText(titleParts, title)} /> : undefined
      }
      legend={chrome.legend ? legend : undefined}
    >
      {bodyLines.map((line, index) => (
        <Text key={index} color={t.text} wrap="truncate-end">
          {line}
        </Text>
      ))}
      <Box height={chrome.listRows} flexDirection="column" flexShrink={0}>
        {/* The mark follows the keyboard: while the composer holds it, ⏎ answers no row. */}
        <ListRows
          lines={layout.lines}
          getKey={(i) => rows[i]?.id ?? ''}
          selectedIndex={selectedIndex}
          focused={focused}
          rowBudget={chrome.listRows}
          width={layout.width - 4}
        />
      </Box>
    </InlineMenuPanel>
  );
}
