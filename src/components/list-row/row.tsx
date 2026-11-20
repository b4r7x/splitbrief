import { Box } from 'ink';
import { segmentsForRowText } from '../../utils/display-text/width.js';
import { stripTerminalControls } from '../../utils/display-text/sanitize.js';
import { ThemeText as Text, useTheme } from '../theme.js';
import { TextSpans } from '../text-spans.js';
import { listRowLead, type ListRowState } from './lead.js';
import type { ListLine } from './plan.js';

export function ListRow({
  line,
  selected,
  width,
  marker = true,
  state = selected ? 'active' : 'default',
}: {
  line: ListLine;
  selected: boolean;
  marker?: boolean;
  state?: ListRowState | undefined;
  width?: number | undefined;
}) {
  const t = useTheme();
  return (
    <Box height={1} width={width ?? '100%'} overflow="hidden">
      {marker && (
        <Box flexShrink={0}>
          <Text color={selected ? t.accent : t.textDim}>
            {listRowLead(line.part === 0 ? state : 'default')}
          </Text>
        </Box>
      )}
      <Box flexGrow={1} minWidth={0} overflow="hidden">
        <Text wrap="truncate-end" color={selected ? t.accent : t.text}>
          <Text color={t.textDim}>{line.keyCell}</Text>
          {line.nameParts ? (
            <TextSpans parts={segmentsForRowText(line.nameParts, line.name)} selected={selected} />
          ) : (
            line.name
          )}
          <Text color={t.textDim}>{line.description}</Text>
        </Text>
      </Box>
      {line.trailing && (
        <Box flexShrink={0}>
          <Text color={t.textDim} wrap="truncate-end">
            {line.trailingGap}
            {line.trailingParts ? (
              <TextSpans parts={segmentsForRowText(line.trailingParts, line.trailing)} />
            ) : (
              line.trailing
            )}
          </Text>
        </Box>
      )}
    </Box>
  );
}

export function ListGroupHeader({ label }: { label: string }) {
  const t = useTheme();
  return (
    <Box height={1} overflow="hidden">
      <Text color={t.textDim} wrap="truncate-end">
        {stripTerminalControls(label)}
      </Text>
    </Box>
  );
}
