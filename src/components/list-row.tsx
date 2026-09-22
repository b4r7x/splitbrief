import { Box, Text } from 'ink';
import { useTheme } from './theme.js';
import { glyph } from '../lib/glyphs.js';
import { SOFT_SEP } from '../core/separators.js';
import {
  ELLIPSIS,
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
  /**
   * Which end of the label the cut takes. `start` keeps the tail, which is what a
   * slash-namespaced id is distinguished by: cutting its tail leaves rows that read alike.
   * `path` keeps the tail too, but gives up whole leading segments, so the cut lands on a
   * separator and what is left is still a whole path.
   */
  labelTruncate?: 'end' | 'start' | 'path' | undefined;
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

const LEAD_BLANK = '  ';
/** A tree row's value is the point of the row, so its connector never squeezes it to nothing. */
const TREE_METADATA_FLOOR = 5;
/** Cells the label keeps whatever the metadata asks for: the metadata has a ceiling of its own. */
export const LIST_ROW_LABEL_FLOOR = 8;
/** What a shed label must not leave standing before its ellipsis: `Kimi K3 ·…`, `output ·…`. */
const HANGING_SEPARATOR = /[\s·:/(-]+$/u;
const HAS_WORD = /[\p{L}\p{N}]/u;

/** A label's whole-word forms, richest first: all of it, then ever fewer leading words and an ellipsis. */
export function wholeWordLabelForms(label: string): string[] {
  const words = label.split(' ');
  const forms = [label];
  for (let kept = words.length - 1; kept >= 1; kept--) {
    const head = words.slice(0, kept).join(' ').replace(HANGING_SEPARATOR, '');
    if (HAS_WORD.test(head)) forms.push(`${head}${ELLIPSIS}`);
  }
  return forms;
}

/** Metadata's forms, richest first: all of it, then ever fewer leading ` · ` segments. */
function metadataForms(metadata: string): string[] {
  const segments = metadata.split(SOFT_SEP);
  return segments.map((_segment, index) =>
    segments.slice(0, segments.length - index).join(SOFT_SEP),
  );
}

interface WholeFit {
  label: string;
  metadata: string | undefined;
  /** Blank alignment cells the row gave up to keep its words whole. */
  spent: number;
}

/**
 * The richest whole-word row that fits, keeping the columns aligned for as long as a pairing of
 * label and metadata fits in the row's own room: alignment is spent before a part is dropped, and
 * a part is dropped before a word is cut. Only a single word wider than the whole row is cut.
 */
function fitWholeWords(
  input: Readonly<{
    label: string;
    metadata: string | undefined;
    room: number;
    spares: readonly number[];
    keep: 'label' | 'metadata';
  }>,
): WholeFit {
  const labels = wholeWordLabelForms(input.label);
  const metadatas = input.metadata === undefined ? [] : metadataForms(input.metadata);
  const pairs =
    input.keep === 'metadata'
      ? metadatas.flatMap((metadata) => labels.map((label) => ({ label, metadata })))
      : metadatas.map((metadata) => ({ label: input.label, metadata }));
  for (const spent of input.spares) {
    const pair = pairs.find(
      ({ label, metadata }) =>
        getTerminalCellWidth(label) + 1 + getTerminalCellWidth(metadata) <= input.room + spent,
    );
    if (pair !== undefined) return { ...pair, spent };
  }
  const alone = (forms: readonly string[]): WholeFit | undefined => {
    for (const spent of input.spares) {
      const form = forms.find((candidate) => getTerminalCellWidth(candidate) <= input.room + spent);
      if (form !== undefined) return { label: form, metadata: undefined, spent };
    }
    return undefined;
  };
  if (input.keep === 'metadata') {
    const value = alone(metadatas);
    if (value !== undefined) return { label: '', metadata: value.label, spent: value.spent };
  }
  const widest = input.spares.at(-1) ?? 0;
  return (
    alone(labels) ?? {
      label: truncateTerminalDisplayText(input.label, input.room + widest),
      metadata: undefined,
      spent: widest,
    }
  );
}

/**
 * `…thropic/claude-opus-4.5` names nothing and rags the column, so a path label sheds whole leading
 * segments: `kilo/anthropic/claude-opus-4.5` at 20 cells reads `…/claude-opus-4.5`.
 */
function elidePathLabel(label: string, width: number): string {
  if (getTerminalCellWidth(label) <= width) return label;
  const segments = label.split('/');
  for (let start = 1; start < segments.length; start++) {
    const candidate = `${ELLIPSIS}/${segments.slice(start).join('/')}`;
    if (getTerminalCellWidth(candidate) <= width) return candidate;
  }
  return label;
}

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
  labelTruncate = 'end',
  keepWhole,
}: ListRowProps) {
  const t = useTheme();
  const accentRow = state === 'active';
  const leadColor = accentRow ? t.accent : t.textDim;
  const lead = state === 'default' && defaultLead === 'dot' ? '· ' : listRowLead(state);
  const labelColor = accentRow ? t.accent : t.text;
  const backgroundColor = hover ? t.selectionBg : undefined;
  const labelWrap = labelTruncate === 'end' ? 'truncate-end' : 'truncate-start';
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
  const trailSpare = hasTrailing && cleanTrailing.trim() === '' ? trailW : 0;
  const checkSpare = selected === false ? checkW : 0;
  const whole =
    keepWhole === undefined || width === undefined
      ? undefined
      : fitWholeWords({
          label: cleanLabel,
          metadata: hasMetadata ? cleanMeta : undefined,
          room: width - leadW - treeW - checkW - trailW,
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
      : Math.max(0, width - leadW - treeW - checkW - trailW - LIST_ROW_LABEL_FLOOR);
  const metaFloor =
    width === undefined || !hasTree
      ? 0
      : Math.min(TREE_METADATA_FLOOR, Math.max(0, width - leadW - treeW - checkW - trailW - 1));
  const metaW =
    whole !== undefined
      ? whole.metadata === undefined
        ? 0
        : getTerminalCellWidth(whole.metadata) + 1
      : metaRoom === undefined
        ? undefined
        : hasMetadata
          ? Math.min(getTerminalCellWidth(cleanMeta) + 1, Math.max(metaRoom, metaFloor))
          : 0;
  const displayMeta =
    whole !== undefined
      ? whole.metadata
      : cleanMeta === undefined
        ? undefined
        : metaW === undefined
          ? cleanMeta
          : truncateTerminalDisplayText(cleanMeta, Math.max(0, metaW - 1));
  const showMetadata = whole === undefined ? hasMetadata : whole.metadata !== undefined;
  const labelW =
    width === undefined
      ? labelWidth
      : (labelWidth ??
        Math.max(
          whole === undefined ? 1 : 0,
          width -
            leadW -
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
        <Text color={labelColor} wrap={labelWrap}>
          {displayLabel}
        </Text>
      </Box>
      {showMetadata ? (
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
      {showTrailing ? (
        <Box width={trailW} flexShrink={0} backgroundColor={backgroundColor}>
          <Text color={trailingColor ?? t.textDim} wrap="truncate-end">
            {' '}
            {cleanTrailing}
          </Text>
        </Box>
      ) : null}
      {showCheck ? (
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
