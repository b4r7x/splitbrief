import { segmentsForRowText } from '../../../utils/display-text.js';
import type { EngineEventOf } from '../../../engine/events/types.js';
import { SOFT_SEP } from '../../../core/separators.js';
import { formatTaskHeading, taskTargetLabel } from '../../../core/run-view/brief-labels.js';
import { formatTaskStartedParts } from './event-format.js';
import type { ConversationRow, ConversationRowBlock, ConversationRowSegment } from './types.js';
import { segmentedRow } from './row-format/rows.js';
import { sanitizeRowDisplayText } from './row-format/text.js';
import { wrapPathAware } from '../../../utils/wrap.js';
import { wrapWidthFor } from './row-markers.js';
import { compositeBlock, wrappedSegmentsBlock } from './row-block-compose.js';

// A break before a separator opens the continuation on that separator, and a break inside the gap
// before the path opens it on a space — `· sonnet` on its own row reads as a new bullet, not as the
// tail of the row above. The continuation marker already says the row continues, so the debris goes.
const LEADING_BREAK = /^\s+(?:·\s+)?|^·\s+/;

function withoutLeadingBreak(segments: ConversationRowSegment[]): ConversationRowSegment[] {
  const full = segments.map((segment) => segment.text).join('');
  const text = full.replace(LEADING_BREAK, '');
  return text === full ? segments : segmentsForRowText(segments, text, full.length - text.length);
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

// The header names one target, and a slice writes more than one file. The anchor plus a count is
// what fits, so the row says the same thing the sidebar and the editor say.
export function taskStartedMetadata(
  event: EngineEventOf<'task_started'>,
): readonly ConversationRowSegment[] {
  const [, ...rest] = formatTaskStartedParts(event);
  return [
    {
      text: taskTargetLabel({
        id: event.taskId,
        title: event.title,
        status: 'in_progress',
        file: event.file,
        ...(event.files === undefined ? {} : { files: [...event.files] }),
        action: event.action,
      }),
      tone: 'textDim',
    },
    ...rest,
  ];
}

export function taskStartedCrewRowBlock(input: {
  keyPrefix: string;
  event: EngineEventOf<'task_started'>;
  width: number;
}): ConversationRowBlock | null {
  const [, ...metadata] = taskStartedMetadata(input.event);
  return compositeBlock(
    input.keyPrefix,
    metadata.map((segment, index) =>
      wrappedSegmentsBlock({
        keyPrefix: `${input.keyPrefix}-metadata-${index}`,
        segments: [segment],
        width: input.width,
      }),
    ),
  );
}

// The header names the brief by its own id, the id the byline, the sidebar and the Tasks card use;
// a position in the plan (`T2`) would name the same brief two ways.
export function taskStartedRowBlock(input: {
  keyPrefix: string;
  taskId: string;
  title: string;
  metadata: readonly ConversationRowSegment[];
  width: number;
}): ConversationRowBlock | null {
  const idText = sanitizeRowDisplayText(input.taskId);
  const titleText = sanitizeRowDisplayText(
    formatTaskHeading({ id: idText, title: input.title }).slice(idText.length),
  );
  const labels = input.metadata.map((label) => ({
    ...label,
    text: sanitizeRowDisplayText(label.text),
  }));
  const placeholder = unusedSpacePlaceholder(
    `${idText}${titleText}${labels.map((label) => label.text).join(' ')}`,
  );
  const metadata = labels.flatMap((label, index): ConversationRowSegment[] => [
    {
      text:
        index === 0 ? '  ' : placeholder === null ? SOFT_SEP : ` ${SOFT_SEP.trim()}${placeholder}`,
      tone: 'textDim',
    },
    { ...label, text: placeholder === null ? label.text : label.text.replaceAll(' ', placeholder) },
  ]);
  const parts: ConversationRowSegment[] = [
    { text: idText, tone: 'text', bold: true },
    { text: titleText, tone: 'text', bold: true },
    ...metadata,
  ];
  const protectedFullText = parts.map((part) => part.text).join('');

  const wrapped = wrapPathAware(protectedFullText, wrapWidthFor('task-header', input.width)).split(
    '\n',
  );
  if (wrapped.length === 0) return null;

  const rows: ConversationRow[] = [];
  let offset = 0;
  for (let lineIndex = 0; lineIndex < wrapped.length; lineIndex += 1) {
    const protectedLine = wrapped[lineIndex] ?? '';
    const line = placeholder === null ? protectedLine : protectedLine.replaceAll(placeholder, ' ');
    // The wrapper drops the space it breaks on, so a line starts where the full text says it does.
    const lineStart = protectedFullText.indexOf(protectedLine, offset);
    const segments = segmentsForRowText(parts, line, lineStart);
    const row = segmentedRow(
      `${input.keyPrefix}-${lineIndex}`,
      lineIndex === 0 ? segments : withoutLeadingBreak(segments),
      'task-header',
    );
    rows.push(lineIndex === 0 ? row : { ...row, headerContinuation: true });
    offset = lineStart + line.length;
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
