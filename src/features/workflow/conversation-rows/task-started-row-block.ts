import type { EngineEventOf } from '../../../engine/events/types.js';
import { SOFT_SEP } from '../../../core/separators.js';
import { taskTargetLabel } from '../../../stores/workflow/tasks.js';
import { formatTaskStartedParts } from './event-format.js';
import type { ConversationRow, ConversationRowBlock, ConversationRowSegment } from './types.js';
import { segmentedRow } from './row-format/rows.js';
import { sanitizeRowDisplayText, wrappedRowTexts } from './row-format/text.js';
import { wrapWidthFor } from './row-markers.js';

// A wrapped continuation carries the space it broke on, and when the break lands before a
// separator it carries that too — `· sonnet` on its own row reads as a new bullet, not as the tail
// of the row above. The continuation marker already says the row continues, so the break debris goes.
const LEADING_BREAK = /^\s+(?:·\s+)?|^·\s+/;

function withoutLeadingBreak(segments: ConversationRowSegment[]): ConversationRowSegment[] {
  const [first, ...rest] = segments;
  if (first === undefined) return segments;
  const text = first.text.replace(LEADING_BREAK, '');
  if (text === first.text) return segments;
  return text.length === 0 ? rest : [{ ...first, text }, ...rest];
}

// Metadata is labels joined by the soft separator — a path, a tool and its model, a worker. A
// label's own spaces are not break points: `OpenCode CLI` split across two rows names nothing on
// either, and a label that carries the separator inside it (the tool and its model) must move
// whole. The placeholder stands in for those spaces while the text wraps and becomes a space
// again after, so the row's own offsets still count the text it paints. The separator straps to
// the label it introduces, so a break can never strand a `·` at a line's end; a continuation loses
// the whole `· ` with the rest of the break debris.
function unusedSpacePlaceholder(text: string): string | null {
  for (let code = 0xe010; code <= 0xf8ff; code += 1) {
    const candidate = String.fromCodePoint(code);
    if (!text.includes(candidate)) return candidate;
  }
  return null;
}

function protectMetadataSpaces(labels: readonly string[], placeholder: string): string {
  return labels
    .map((label) => label.replaceAll(' ', placeholder))
    .join(` ${SOFT_SEP.trim()}${placeholder}`);
}

// The header names one target, and a slice writes more than one file. The anchor plus a count is
// what fits, so the row says the same thing the sidebar and the editor say.
export function taskStartedMetadata(event: EngineEventOf<'task_started'>): readonly string[] {
  const [, ...rest] = formatTaskStartedParts(event);
  return [
    taskTargetLabel({
      id: event.taskId,
      title: event.title,
      status: 'in_progress',
      file: event.file,
      ...(event.files === undefined ? {} : { files: [...event.files] }),
      action: event.action,
    }),
    ...rest,
  ];
}

// The header names the brief by its own id, the id the byline, the sidebar and the Tasks card use;
// a position in the plan (`T2`) would name the same brief two ways.
export function taskStartedRowBlock(input: {
  keyPrefix: string;
  taskId: string;
  title: string;
  metadata: readonly string[];
  width: number;
}): ConversationRowBlock | null {
  const idText = sanitizeRowDisplayText(input.taskId);
  const titleText = sanitizeRowDisplayText(` ${input.title}`);
  const labels = input.metadata.map((label) => sanitizeRowDisplayText(label));
  const placeholder = unusedSpacePlaceholder(`${idText}${titleText}${labels.join(' ')}`);
  const metadataText =
    placeholder === null
      ? `  ${labels.join(SOFT_SEP)}`
      : `  ${protectMetadataSpaces(labels, placeholder)}`;
  const protectedFullText = `${idText}${titleText}${metadataText}`;
  const idEnd = idText.length;
  const titleEnd = idEnd + titleText.length;

  const wrapped = wrappedRowTexts(protectedFullText, wrapWidthFor('task-header', input.width)).map(
    (line) => (placeholder === null ? line : line.replaceAll(placeholder, ' ')),
  );
  if (wrapped.length === 0) return null;

  const rows: ConversationRow[] = [];
  let offset = 0;
  for (let lineIndex = 0; lineIndex < wrapped.length; lineIndex += 1) {
    const line = wrapped[lineIndex] ?? '';
    const lineStart = offset;
    const lineEnd = offset + line.length;
    const segments: ConversationRowSegment[] = [];
    let pos = lineStart;
    while (pos < lineEnd) {
      let regionEnd: number;
      let tone: ConversationRowSegment['tone'];
      let bold = false;
      if (pos < idEnd) {
        regionEnd = Math.min(idEnd, lineEnd);
        tone = 'text';
        bold = true;
      } else if (pos < titleEnd) {
        regionEnd = Math.min(titleEnd, lineEnd);
        tone = 'text';
        bold = true;
      } else {
        regionEnd = lineEnd;
        tone = 'textDim';
      }
      const segment: ConversationRowSegment = {
        text: line.slice(pos - lineStart, regionEnd - lineStart),
        tone,
      };
      if (bold) segment.bold = true;
      segments.push(segment);
      pos = regionEnd;
    }
    const row = segmentedRow(
      `${input.keyPrefix}-${lineIndex}`,
      lineIndex === 0 ? segments : withoutLeadingBreak(segments),
      'task-header',
    );
    rows.push(lineIndex === 0 ? row : { ...row, headerContinuation: true });
    offset = lineEnd;
  }

  // The marker lives on the first row — every later row is a continuation and draws the message
  // leading. Pointing "active" at the last row left a running task wearing the done glyph.
  const activeRowKey = rows[0]?.key;

  return {
    key: input.keyPrefix,
    rowCount: rows.length,
    renderableUnits: 1,
    ...(activeRowKey !== undefined ? { activeRowKey } : {}),
    createRows: (windowStart, windowEnd) => rows.slice(windowStart, windowEnd),
  };
}
