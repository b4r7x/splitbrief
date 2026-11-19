import { Box } from 'ink';
import { SOFT_SEP } from '../../core/separators.js';
import { glyph } from '../../lib/glyphs.js';
import { stripTerminalControls } from '../../utils/display-text/sanitize.js';
import { truncateTerminalDisplayText, elidePathLabel } from '../../utils/display-text/truncate.js';
import { getTerminalCellWidth, segmentsForRowText } from '../../utils/display-text/width.js';
import { TextSpans } from '../text-spans.js';
import { useTheme, ThemeText as Text } from '../theme.js';
import { fitWholeWords, LIST_ROW_LABEL_FLOOR } from './fit.js';
import { type ListRowState, listRowLead } from './lead.js';

interface ListRowBaseProps {
  label: string;
  state?: ListRowState | undefined;
  accelerator?: string | undefined;
  acceleratorWidth?: number | undefined;
  metadataAfterLabel?: boolean | undefined;
  /** The connector drawn between the lead gutter and the label, in the border hue. */
  treeLead?: string | undefined;
  metadata?: string | undefined;
  metadataTone?: 'text' | 'warning' | 'dim' | undefined;
  trailing?: string | undefined;
  trailingColor?: string | undefined;
  selected?: boolean | undefined;
  width?: number | undefined;
  labelWidth?: number | undefined;
  /**
   * Set, the row cuts no word: `med…` names no level and `opencod…` no provider. The metadata
   * sheds whole ` · ` segments from its tail and the label whole words from its tail, and a row
   * over its width spends its blank alignment cells (a blank trailing cell, an unticked check)
   * before it gives a part up. The value names the part that outranks the other: `label` shows
   * the metadata only beside the whole label; `metadata` lets the label shed words, and at last
   * go, before the metadata does. Unset, both are cut at their ends.
   */
  keepWhole?: 'label' | 'metadata' | undefined;
}

type ListRowProps = ListRowBaseProps &
  (
    | { labelParts?: undefined; labelTruncate?: 'end' | 'start' | 'path' | undefined }
    | {
        labelParts: readonly Readonly<{ text: string; color?: string | undefined }>[];
        labelTruncate?: 'end' | undefined;
      }
  );
/** A tree row's value is the point of the row, so its connector never squeezes it to nothing. */
const TREE_METADATA_FLOOR = 5;

export function ListRow({
  label,
  labelParts,
  state = 'default',
  accelerator,
  acceleratorWidth,
  metadataAfterLabel,
  treeLead,
  metadata,
  metadataTone = 'dim',
  trailing,
  trailingColor,
  selected,
  width,
  labelWidth,
  labelTruncate = 'end',
  keepWhole,
}: ListRowProps) {
  const t = useTheme();
  const metadataColor = metadataTone === 'dim' ? t.textDim : t[metadataTone];
  const accentRow = state === 'active';
  const leadColor = accentRow ? t.accent : t.textDim;
  const labelColor = accentRow ? t.accent : t.text;
  const labelWrap = labelTruncate === 'end' ? 'truncate-end' : 'truncate-start';
  const cleanLabel = stripTerminalControls(label);
  const cleanMeta = metadata === undefined ? undefined : stripTerminalControls(metadata);
  const cleanTrailing = trailing === undefined ? undefined : stripTerminalControls(trailing);
  const cleanTree = treeLead === undefined ? undefined : stripTerminalControls(treeLead);
  const hasMetadata = cleanMeta !== undefined && cleanMeta !== '';
  const hasTrailing = cleanTrailing !== undefined && cleanTrailing !== '';
  const hasTree = cleanTree !== undefined && cleanTree !== '';
  const leadW = 2;
  const accelW = acceleratorWidth === undefined ? 0 : acceleratorWidth + 3;
  const checkW = typeof selected === 'boolean' ? 2 : 0;
  const trailW = hasTrailing ? getTerminalCellWidth(cleanTrailing) + 1 : 0;
  const treeW = hasTree ? getTerminalCellWidth(cleanTree) : 0;
  const trailSpare = hasTrailing && cleanTrailing.trim() === '' ? trailW : 0;
  const checkSpare = selected === false ? checkW : 0;
  const metaGap = metadataAfterLabel === true ? SOFT_SEP : ' ';
  const metaGapW = getTerminalCellWidth(metaGap);
  const whole =
    keepWhole === undefined || width === undefined
      ? undefined
      : fitWholeWords({
          label: cleanLabel,
          metadata: hasMetadata ? cleanMeta : undefined,
          room: width - leadW - accelW - treeW - checkW - trailW,
          gap: metaGapW,
          spares: [...new Set([0, trailSpare, trailSpare + checkSpare])],
          keep: keepWhole,
        });
  const showTrailing = hasTrailing && !(trailSpare > 0 && (whole?.spent ?? 0) >= trailSpare);
  const showCheck =
    typeof selected === 'boolean' &&
    !(checkSpare > 0 && (whole?.spent ?? 0) >= trailSpare + checkSpare);
  const metaRoom =
    width === undefined
      ? undefined
      : Math.max(0, width - leadW - accelW - treeW - checkW - trailW - LIST_ROW_LABEL_FLOOR);
  const metaFloor =
    width === undefined || !hasTree
      ? 0
      : Math.min(
          TREE_METADATA_FLOOR,
          Math.max(0, width - leadW - accelW - treeW - checkW - trailW - 1),
        );
  const metaW =
    whole !== undefined
      ? whole.metadata === undefined
        ? 0
        : getTerminalCellWidth(whole.metadata) + metaGapW
      : metaRoom === undefined
        ? undefined
        : hasMetadata
          ? Math.min(getTerminalCellWidth(cleanMeta) + metaGapW, Math.max(metaRoom, metaFloor))
          : 0;
  const displayMeta =
    whole !== undefined
      ? whole.metadata
      : cleanMeta === undefined
        ? undefined
        : metaW === undefined
          ? cleanMeta
          : truncateTerminalDisplayText(cleanMeta, Math.max(0, metaW - metaGapW));
  const showMetadata = whole === undefined ? hasMetadata : whole.metadata !== undefined;
  const labelW =
    width === undefined
      ? labelWidth
      : (labelWidth ??
        Math.max(
          whole === undefined ? 1 : 0,
          width -
            leadW -
            accelW -
            treeW -
            (metaW ?? 0) -
            (showTrailing ? trailW : 0) -
            (showCheck ? checkW : 0),
        ));

  const displayLabel =
    whole !== undefined
      ? whole.label
      : labelTruncate === 'path' && labelW !== undefined
        ? elidePathLabel(cleanLabel, labelW)
        : cleanLabel;
  const labelBoxW =
    metadataAfterLabel === true
      ? Math.min(getTerminalCellWidth(displayLabel), labelW ?? getTerminalCellWidth(displayLabel))
      : labelW;

  const fittedLabelParts =
    labelParts === undefined
      ? undefined
      : segmentsForRowText(
          labelParts.map((part) => ({ ...part, text: stripTerminalControls(part.text) })),
          displayLabel,
        );

  return (
    <Box width={width} height={1} overflow="hidden">
      <Text color={leadColor}>{listRowLead(state)}</Text>
      {acceleratorWidth !== undefined ? (
        <Box width={accelW} flexShrink={0}>
          <Text color={t.textDim}>{`${(accelerator ?? '').padEnd(acceleratorWidth)}   `}</Text>
        </Box>
      ) : null}
      {hasTree ? (
        <Box width={treeW} flexShrink={0}>
          <Text color={t.border}>{cleanTree}</Text>
        </Box>
      ) : null}
      <Box
        {...(labelBoxW === undefined
          ? { flexGrow: 1, flexShrink: 1 }
          : { width: labelBoxW, flexShrink: 0 })}
        minWidth={0}
        overflow="hidden"
      >
        <Text color={labelColor} wrap={labelWrap}>
          {fittedLabelParts === undefined ? (
            displayLabel
          ) : (
            <TextSpans
              parts={fittedLabelParts.map((part) => ({
                text: part.text,
                color: part.color ?? labelColor,
              }))}
            />
          )}
        </Text>
      </Box>
      {showMetadata ? (
        <Box
          {...(metaW === undefined ? { flexShrink: 1 } : { width: metaW, flexShrink: 0 })}
          minWidth={0}
          overflow="hidden"
        >
          <Text color={metadataColor} wrap="truncate-end">
            {metaGap}
            {displayMeta}
          </Text>
        </Box>
      ) : null}
      {labelWidth !== undefined ? <Box flexGrow={1} /> : null}
      {showTrailing ? (
        <Box width={trailW} flexShrink={0}>
          <Text color={trailingColor ?? t.textDim} wrap="truncate-end">
            {' '}
            {cleanTrailing}
          </Text>
        </Box>
      ) : null}
      {showCheck ? (
        <Box width={checkW} flexShrink={0}>
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
