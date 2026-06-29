import { Box, Text } from 'ink';
import { useTheme } from './theme.js';
import { glyph } from '../lib/glyphs.js';
import { stripTerminalControls } from '../utils/display-text.js';

export type ListRowState = 'default' | 'active';
export type ListRowDefaultLead = 'blank' | 'dot';

interface ListRowProps {
  label: string;
  state?: ListRowState | undefined;
  defaultLead?: ListRowDefaultLead | undefined;
  metadata?: string | undefined;
  trailing?: string | undefined;
  selected?: boolean | undefined;
  hover?: boolean | undefined;
  width?: number | undefined;
  labelWidth?: number | undefined;
}

const LEAD_BLANK = '  ';

function listRowLead(state: ListRowState): string {
  return state === 'active' ? `${glyph('liveBar')} ` : LEAD_BLANK;
}

export function ListRow({
  label,
  state = 'default',
  defaultLead = 'blank',
  metadata,
  trailing,
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

  return (
    <Box width={width} height={1} overflow="hidden" backgroundColor={backgroundColor}>
      <Text color={leadColor}>{lead}</Text>
      <Box
        {...(labelWidth === undefined
          ? { flexGrow: 1, flexShrink: 1 }
          : { width: labelWidth, flexShrink: 0 })}
        minWidth={0}
        overflow="hidden"
        backgroundColor={backgroundColor}
      >
        <Text color={labelColor} wrap="truncate-end">
          {cleanLabel}
        </Text>
      </Box>
      {cleanMeta !== undefined && cleanMeta !== '' ? (
        <Box flexShrink={1} minWidth={0} overflow="hidden" backgroundColor={backgroundColor}>
          <Text color={t.textDim} wrap="truncate-end">
            {' '}
            {cleanMeta}
          </Text>
        </Box>
      ) : null}
      {cleanTrailing !== undefined && cleanTrailing !== '' ? (
        <>
          <Box flexGrow={1} backgroundColor={backgroundColor} />
          <Box flexShrink={0} backgroundColor={backgroundColor}>
            <Text color={t.textDim} wrap="truncate-end">
              {' '}
              {cleanTrailing}
            </Text>
          </Box>
        </>
      ) : null}
      {selected ? (
        <>
          {cleanTrailing === undefined || cleanTrailing === '' ? (
            <Box flexGrow={1} backgroundColor={backgroundColor} />
          ) : null}
          <Box flexShrink={0} backgroundColor={backgroundColor}>
            <Text color={t.success}> {glyph('check')}</Text>
          </Box>
        </>
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
