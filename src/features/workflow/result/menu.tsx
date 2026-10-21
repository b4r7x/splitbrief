import { segmentsForRowText } from '../../../utils/display-text.js';
import { ThemeText as Text, useTheme } from '../../../components/theme.js';
import { Box, useInput } from 'ink';
import { borderStyleFor } from '../../../lib/glyphs.js';
import { listRowLead } from '../../../components/list-row.js';
import { fitKeyLegend } from '../../../core/key-legend.js';
import { useStaticSelector } from '../../../hooks/use-static-selector.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { stopMenuLayout } from '../stop/options.js';
import { slashHandoffPending } from '../slash-handoff.js';
import { TextSpans } from '../../../components/text-spans.js';
import {
  RESULT_MENU_LEGEND,
  RESULT_MENU_UNFOCUSED_LEGEND,
  resultMenuFindingLines,
  resultMenuRows,
  resultMenuTitle,
  resultRowCommand,
  type ResultRow,
} from './options.js';

export interface ResultMenuProps {
  override: boolean;
  findings: readonly string[];
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
  const input = { override, findings, confirming, files };
  const rows = resultMenuRows(input);
  const layout = stopMenuLayout(rows, cols);

  const { selectedIndex } = useStaticSelector<ResultRow>({
    items: rows,
    isActive: focused,
    keyOf: (row) => row.id,
    shouldHandleInput: () => !slashHandoffPending(),
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
  const boxHeight = height ?? layout.height + (confirming ? findings.length : 0);
  // Border, title and legend take four rows; the actions keep theirs, the findings get the rest.
  const findingLines = confirming
    ? resultMenuFindingLines(findings, boxHeight - 4 - layout.bodyRows)
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
      borderStyle={borderStyleFor('single')}
      borderColor={focused ? t.accent : t.border}
      borderDimColor={!focused}
      paddingX={1}
      flexDirection="column"
      overflow="hidden"
      flexShrink={0}
    >
      <Text color={t.textDim} wrap="truncate-end">
        <TextSpans parts={segmentsForRowText(titleParts, title)} />
      </Text>
      {findingLines.map((line, index) => (
        <Text key={index} color={t.text} wrap="truncate-end">
          {line}
        </Text>
      ))}
      <Box height={layout.bodyRows} flexDirection="column" flexShrink={0}>
        {layout.options.map(({ row, parts }, index) => {
          // The mark follows the keyboard: while the composer holds it, ⏎ answers no row.
          const marked = focused && index === selectedIndex;
          return (
            <Box key={row.id} flexDirection="column">
              {parts.map((line, lineIndex) => (
                <Text key={lineIndex} color={marked ? t.accent : t.textDim}>
                  {listRowLead(marked && lineIndex === 0 ? 'active' : 'default')}
                  <TextSpans parts={line} selected={marked} />
                </Text>
              ))}
            </Box>
          );
        })}
      </Box>
      <Text color={t.textDim}>{legend}</Text>
    </Box>
  );
}
