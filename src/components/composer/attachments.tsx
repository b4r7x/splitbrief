import { Box, Text } from 'ink';
import { randomUUID } from 'node:crypto';
import { useTheme } from '../theme.js';
import { useStores } from '../../stores/use-stores.js';
import { attachmentShortName } from '../../core/attachments/resolve.js';
import { attachmentsStore } from '../../stores/workflow/attachments.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { getTerminalCellWidth, truncateTerminalDisplayText } from '../../utils/display-text.js';

const ATTACHMENT_CHIP_MAX_CELLS = 32;
const PASTE_LINE_THRESHOLD = 4;
const NARROW_COMPOSER_COLS = 50;
const NARROW_CHIP_CAP = 2;

export interface PasteMarker {
  id: string;
  lineCount: number;
  marker: string;
  text: string;
}

export function attachmentChipLabel(path: string, index: number): string {
  const prefix = `📎 ${index + 1} `;
  const maxNameCells = Math.max(1, ATTACHMENT_CHIP_MAX_CELLS - getTerminalCellWidth(prefix));
  return `${prefix}${truncateTerminalDisplayText(attachmentShortName(path), maxNameCells)}`;
}

export function pasteChipLabel(
  index: number,
  lineCount: number,
  options: { short?: boolean } = {},
): string {
  return options.short
    ? `[paste #${index + 1} +${lineCount}]`
    : `[paste #${index + 1} +${lineCount} lines]`;
}

export function pasteLineCount(text: string): number {
  if (text.length === 0) return 0;
  return text.split('\n').length;
}

export function extractPasteCapture(
  previous: string,
  next: string,
): { remaining: string; text: string; lineCount: number; insertAt: number } | null {
  if (next.length <= previous.length) return null;

  let prefix = 0;
  while (prefix < previous.length && prefix < next.length && previous[prefix] === next[prefix]) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < previous.length - prefix &&
    suffix < next.length - prefix &&
    previous[previous.length - 1 - suffix] === next[next.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const inserted = next.slice(prefix, next.length - suffix);
  const lineCount = pasteLineCount(inserted);
  if (lineCount < PASTE_LINE_THRESHOLD) return null;

  return {
    remaining: next.slice(0, prefix) + next.slice(next.length - suffix),
    insertAt: prefix,
    text: inserted,
    lineCount,
  };
}

export function pasteDraftMarker(token: string = randomUUID()): string {
  return `[paste:${token}]`;
}

export function insertPasteDraftMarker(text: string, insertAt: number, marker: string): string {
  const at = Math.max(0, Math.min(insertAt, text.length));
  return text.slice(0, at) + marker + text.slice(at);
}

export function expandPastes(text: string, pastes: PasteMarker[]): string {
  if (pastes.length === 0) return text;

  let expanded = text;
  const used = new Set<string>();
  for (let index = 0; index < pastes.length; index += 1) {
    const paste = pastes[index];
    if (paste === undefined) continue;
    const marker = paste.marker;
    if (!expanded.includes(marker)) continue;
    expanded = expanded.replace(marker, paste.text);
    used.add(paste.id);
  }

  const trailing = pastes.filter((paste) => !used.has(paste.id)).map((paste) => paste.text);
  if (trailing.length === 0) return expanded;
  return expanded.length === 0 ? trailing.join('\n\n') : [expanded, ...trailing].join('\n\n');
}

// How many terminal rows AttachmentChips paints above the input box, derived deterministically so
// the composer can reserve that budget in inputHeightStore. Must track the component's render: the
// narrow form caps to NARROW_CHIP_CAP rows plus a "+N more" tail; the wide form greedily wraps each
// chip (label + its marginRight) inside the paddingX-1 container.
export function attachmentChipRows(
  pastes: PasteMarker[],
  pending: readonly { path: string }[],
  cols: number,
): number {
  const total = pastes.length + pending.length;
  if (total === 0) return 0;

  if (cols < NARROW_COMPOSER_COLS) {
    const shown = Math.min(total, NARROW_CHIP_CAP);
    return shown + (total > shown ? 1 : 0);
  }

  const available = Math.max(1, cols - 2);
  const widths = [
    ...pastes.map(
      (paste, index) => getTerminalCellWidth(pasteChipLabel(index, paste.lineCount)) + 1,
    ),
    ...pending.map(
      (attachment, index) => getTerminalCellWidth(attachmentChipLabel(attachment.path, index)) + 1,
    ),
  ];

  let rows = 1;
  let lineWidth = 0;
  for (const width of widths) {
    if (lineWidth > 0 && lineWidth + width > available) {
      rows += 1;
      lineWidth = width;
    } else {
      lineWidth += width;
    }
  }
  return rows;
}

export function AttachmentChips({ pastes = [] }: { pastes?: PasteMarker[] }) {
  const theme = useTheme();
  const [{ pending }, { cols }] = useStores(attachmentsStore, terminalSizeStore);
  if (pending.length === 0 && pastes.length === 0) return null;

  if (cols < NARROW_COMPOSER_COLS) {
    const markers = [
      ...pastes.map((paste, i) => ({
        key: paste.id,
        label: pasteChipLabel(i, paste.lineCount, { short: true }),
      })),
      ...pending.map((a, i) => ({ key: a.id, label: attachmentChipLabel(a.path, i) })),
    ];
    const shown = markers.slice(-NARROW_CHIP_CAP);
    const hidden = markers.length - shown.length;
    return (
      <Box flexDirection="column" paddingX={1}>
        {shown.map((marker) => (
          <Text key={marker.key} color={theme.textDim} wrap="truncate-end">
            {marker.label}
          </Text>
        ))}
        {hidden > 0 ? <Text color={theme.textDim}>{`+${hidden} more`}</Text> : null}
      </Box>
    );
  }

  return (
    <Box flexDirection="row" flexWrap="wrap" paddingX={1}>
      {pastes.map((paste, i) => (
        <Box key={paste.id} marginRight={1}>
          <Text color={theme.textDim}>{pasteChipLabel(i, paste.lineCount)}</Text>
        </Box>
      ))}
      {pending.map((a, i) => (
        <Box key={a.id} marginRight={1}>
          <Text color={theme.textDim}>{attachmentChipLabel(a.path, i)}</Text>
        </Box>
      ))}
    </Box>
  );
}
