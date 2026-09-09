import { Box, Text } from 'ink';
import { useTheme } from './theme.js';
import { glyph } from '../lib/glyphs.js';
import {
  getTerminalCellWidth,
  stripTerminalControls,
  truncateTerminalDisplayText,
} from '../utils/display-text.js';

export type ListRowState = 'default' | 'active' | 'context';
export type ListRowDefaultLead = 'blank' | 'dot';

interface ListRowProps {
  label: string;
  state?: ListRowState | undefined;
  defaultLead?: ListRowDefaultLead | undefined;
  /** The connector drawn between the lead gutter and the label, in the border hue. */
  treeLead?: string | undefined;
  metadata?: string | undefined;
  /** Overrides the metadata hue; defaults to the dim text colour. */
  metadataColor?: string | undefined;
  trailing?: string | undefined;
  trailingColor?: string | undefined;
  selected?: boolean | undefined;
  hover?: boolean | undefined;
  width?: number | undefined;
  labelWidth?: number | undefined;
}

const LEAD_BLANK = '  ';
/** A tree row's value is the point of the row, so its connector never squeezes it to nothing. */
const TREE_METADATA_FLOOR = 5;

export function listRowLead(state: ListRowState): string {
  return state === 'active' || state === 'context' ? `${glyph('liveBar')} ` : LEAD_BLANK;
}

export function ListRow({
  label,
  state = 'default',
  defaultLead = 'blank',
  treeLead,
  metadata,
  metadataColor,
  trailing,
  trailingColor,
  selected,
  hover,
  width,
  labelWidth,
}: ListRowProps) {
  const t = useTheme();
  const accentRow = state === 'active';
  const leadColor = accentRow ? t.accent : t.textDim;
  const lead = state === 'default' && defaultLead === 'dot' ? '· ' : listRowLead(state);
  const labelColor = accentRow ? t.accent : t.text;
  const backgroundColor = hover ? t.selectionBg : undefined;
  const cleanLabel = stripTerminalControls(label);
  const cleanMeta = metadata === undefined ? undefined : stripTerminalControls(metadata);
  const cleanTrailing = trailing === undefined ? undefined : stripTerminalControls(trailing);
  const cleanTree = treeLead === undefined ? undefined : stripTerminalControls(treeLead);
  const hasMetadata = cleanMeta !== undefined && cleanMeta !== '';
  const hasTrailing = cleanTrailing !== undefined && cleanTrailing !== '';
  const hasTree = cleanTree !== undefined && cleanTree !== '';
  const leadW = 2;
  const checkW = typeof selected === 'boolean' ? 2 : 0;
  const trailW = hasTrailing ? getTerminalCellWidth(cleanTrailing) + 1 : 0;
  const treeW = hasTree ? getTerminalCellWidth(cleanTree) : 0;
  const metaRoom =
    width === undefined ? undefined : Math.max(0, width - leadW - treeW - checkW - trailW - 8);
  const metaFloor =
    width === undefined || !hasTree
      ? 0
      : Math.min(TREE_METADATA_FLOOR, Math.max(0, width - leadW - treeW - checkW - trailW - 1));
  const metaW =
    metaRoom === undefined
      ? undefined
      : hasMetadata
        ? Math.min(getTerminalCellWidth(cleanMeta) + 1, Math.max(metaRoom, metaFloor))
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
      : (labelWidth ?? Math.max(1, width - leadW - treeW - (metaW ?? 0) - trailW - checkW));

  return (
    <Box width={width} height={1} overflow="hidden" backgroundColor={backgroundColor}>
      <Text color={leadColor}>{lead}</Text>
      {hasTree ? (
        <Box width={treeW} flexShrink={0} backgroundColor={backgroundColor}>
          <Text color={t.border}>{cleanTree}</Text>
        </Box>
      ) : null}
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
          <Text color={metadataColor ?? t.textDim} wrap="truncate-end">
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
