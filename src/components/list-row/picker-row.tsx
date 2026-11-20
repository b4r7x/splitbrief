import { useStdout } from 'ink';
import { planListRows } from './plan.js';
import type { TextSpan } from '../text-spans.js';
import { ListRow } from './row.js';
import { glyph } from '../../lib/glyphs.js';
import { stripTerminalControls } from '../../utils/display-text/sanitize.js';
import {
  truncateTerminalDisplayText,
  elidePathLabel,
  truncateTerminalDisplayTextStart,
} from '../../utils/display-text/truncate.js';
import { getTerminalCellWidth, segmentsForRowText } from '../../utils/display-text/width.js';
import { useTheme } from '../theme.js';
import { fitWholeWords, LIST_ROW_LABEL_FLOOR } from './fit.js';
import type { ListRowState } from './lead.js';

interface ListRowBaseProps {
  label: string;
  state?: ListRowState | undefined;
  /** The connector drawn between the lead gutter and the label, in the border hue. */
  treeLead?: string | undefined;
  metadata?: string | undefined;
  metadataTone?: 'text' | 'warning' | 'dim' | undefined;
  trailing?: string | undefined;
  trailingColor?: string | undefined;
  selected?: boolean | undefined;
  width?: number | undefined;
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

export function PickerRow({
  label,
  labelParts,
  state = 'default',
  treeLead,
  metadata,
  metadataTone = 'dim',
  trailing,
  trailingColor,
  selected,
  width,
  labelTruncate = 'end',
  keepWhole,
}: ListRowProps) {
  const t = useTheme();
  const { stdout } = useStdout();
  const metadataColor = metadataTone === 'dim' ? t.textDim : t[metadataTone];
  const accentRow = state === 'active';
  const labelColor = accentRow ? t.accent : t.text;
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
  const metaGapW = 2;
  const whole =
    keepWhole === undefined || width === undefined
      ? undefined
      : fitWholeWords({
          label: cleanLabel,
          metadata: hasMetadata ? cleanMeta : undefined,
          room: width - leadW - treeW - checkW - trailW,
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
      : Math.max(
          0,
          width -
            leadW -
            treeW -
            checkW -
            trailW -
            Math.min(LIST_ROW_LABEL_FLOOR, getTerminalCellWidth(cleanLabel)),
        );
  const metaFloor =
    width === undefined || !hasTree
      ? 0
      : Math.min(TREE_METADATA_FLOOR, Math.max(0, width - leadW - treeW - checkW - trailW - 1));
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
      ? undefined
      : Math.max(
          whole === undefined ? 1 : 0,
          width -
            leadW -
            treeW -
            (metaW ?? 0) -
            (showTrailing ? trailW : 0) -
            (showCheck ? checkW : 0),
        );

  const displayLabel =
    whole !== undefined
      ? whole.label
      : labelTruncate === 'path' && labelW !== undefined
        ? elidePathLabel(cleanLabel, labelW)
        : cleanLabel;
  const labelText =
    labelW === undefined
      ? displayLabel
      : labelTruncate === 'start'
        ? truncateTerminalDisplayTextStart(displayLabel, labelW)
        : truncateTerminalDisplayText(displayLabel, labelW);
  const parts: TextSpan[] = [
    ...(hasTree ? [{ text: cleanTree, color: t.border }] : []),
    ...(labelParts
      ? segmentsForRowText(
          labelParts.map((part) => ({ text: part.text, color: part.color ?? labelColor })),
          labelText,
        )
      : [{ text: labelText, color: labelColor }]),
  ];
  const right: TextSpan[] = [
    ...(showMetadata && displayMeta ? [{ text: displayMeta, color: metadataColor }] : []),
    ...(showTrailing ? [{ text: ' ' + cleanTrailing, color: trailingColor ?? t.textDim }] : []),
    ...(showCheck ? [{ text: selected ? ' ' + glyph('check') : '  ', color: t.success }] : []),
  ];
  const [line] = planListRows(
    [
      {
        name: parts.map((part) => part.text).join(''),
        nameParts: parts,
        trailing: right.map((part) => part.text).join(''),
        trailingParts: right,
      },
    ],
    { width: width ?? stdout.columns },
  );
  return line ? <ListRow line={line} selected={accentRow} state={state} width={width} /> : null;
}
