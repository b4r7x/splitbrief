import { Box, Text } from 'ink';
import { useTheme } from './theme.js';
import { glyph } from '../lib/glyphs.js';
import {
  getTerminalCellWidth,
  stripTerminalControls,
  truncateTerminalDisplayText,
} from '../utils/display-text.js';

export type ListRowState = 'default' | 'active';
export type ListRowDefaultLead = 'blank' | 'dot';

interface ListRowProps {
  label: string;
  state?: ListRowState | undefined;
  defaultLead?: ListRowDefaultLead | undefined;
  metadata?: string | undefined;
  trailing?: string | undefined;
  trailingColor?: string | undefined;
  selected?: boolean | undefined;
  hover?: boolean | undefined;
  width?: number | undefined;
  labelWidth?: number | undefined;
}

const LEAD_BLANK = '  ';

export function listRowLead(state: ListRowState): string {
  return state === 'active' ? `${glyph('liveBar')} ` : LEAD_BLANK;
}

export function ListRow({
  label,
  state = 'default',
  defaultLead = 'blank',
  metadata,
  trailing,
  trailingColor,
  selected,
  hover,
  width,
  labelWidth,
}: ListRowProps) {
  const t = useTheme();
  const accentRow = state !== 'default';
  const leadColor = accentRow ? t.accent : t.textDim;
  const lead = state === 'default' && defaultLead === 'dot' ? '· ' : listRowLead(state);
  const labelColor = accentRow ? t.accent : t.text;
  const backgroundColor = hover ? t.selectionBg : undefined;
  const cleanLabel = stripTerminalControls(label);
  const cleanMeta = metadata === undefined ? undefined : stripTerminalControls(metadata);
  const cleanTrailing = trailing === undefined ? undefined : stripTerminalControls(trailing);
  const hasMetadata = cleanMeta !== undefined && cleanMeta !== '';
  const hasTrailing = cleanTrailing !== undefined && cleanTrailing !== '';
  const leadW = 2;
  const checkW = typeof selected === 'boolean' ? 2 : 0;
  const trailW = hasTrailing ? getTerminalCellWidth(cleanTrailing) + 1 : 0;
  const metaW =
    width === undefined
      ? undefined
      : hasMetadata
        ? Math.min(
            getTerminalCellWidth(cleanMeta) + 1,
            Math.max(0, width - leadW - checkW - trailW - 8),
          )
        : 0;
  const displayMeta =
    cleanMeta === undefined
      ? undefined
      : metaW === undefined
        ? cleanMeta
        : truncateTerminalDisplayText(cleanMeta, Math.max(0, metaW - 1));
  const labelW =
    width === undefined
      ? labelWidth
      : (labelWidth ?? Math.max(1, width - leadW - (metaW ?? 0) - trailW - checkW));

  return (
    <Box width={width} height={1} overflow="hidden" backgroundColor={backgroundColor}>
      <Text color={leadColor}>{lead}</Text>
      <Box
        {...(labelW === undefined
          ? { flexGrow: 1, flexShrink: 1 }
          : { width: labelW, flexShrink: 0 })}
        minWidth={0}
        overflow="hidden"
        backgroundColor={backgroundColor}
      >
        <Text color={labelColor} wrap="truncate-end">
          {cleanLabel}
        </Text>
      </Box>
      {hasMetadata ? (
        <Box
          {...(metaW === undefined ? { flexShrink: 1 } : { width: metaW, flexShrink: 0 })}
          minWidth={0}
          overflow="hidden"
          backgroundColor={backgroundColor}
        >
          <Text color={t.textDim} wrap="truncate-end">
            {' '}
            {displayMeta}
          </Text>
        </Box>
      ) : null}
      {labelWidth !== undefined ? <Box flexGrow={1} backgroundColor={backgroundColor} /> : null}
      {hasTrailing ? (
        <Box width={trailW} flexShrink={0} backgroundColor={backgroundColor}>
          <Text color={trailingColor ?? t.textDim} wrap="truncate-end">
            {' '}
            {cleanTrailing}
          </Text>
        </Box>
      ) : null}
      {typeof selected === 'boolean' ? (
        <Box width={checkW} flexShrink={0} backgroundColor={backgroundColor}>
          <Text {...(selected ? { color: t.success } : {})}>
            {selected ? ` ${glyph('check')}` : '  '}
          </Text>
        </Box>
      ) : null}
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
