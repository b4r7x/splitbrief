import { getMaxVisibleDiffLines } from '../layout/diff-height.js';
import type { EngineEvent } from '../../../engine/events/types.js';
import type { StreamingOutputState } from '../../../stores/workflow/streaming-output.js';
import { formatDuration } from '../../../utils/format-time.js';
import type { ConversationRow, ConversationRowTone, RowBuildContext } from './types.js';
import { row, sanitizeRowDisplayText } from './row-format.js';

export function implementerDoneRows(
  keyPrefix: string,
  event: Extract<EngineEvent, { type: 'implementer_generate_done' }>,
  ctx: RowBuildContext,
  expanded: boolean,
): ConversationRow[] {
  const rows = [
    row({
      key: `${keyPrefix}-header`,
      text: `${event.file}  ${formatDuration(event.duration)}`,
      tone: 'implementer',
    }),
  ];

  if (!event.diff) {
    rows.push(
      row({
        key: `${keyPrefix}-summary`,
        text: `${event.file} (+${event.linesAdded} -${event.linesRemoved})`,
        tone: 'textDim',
      }),
    );
    return rows;
  }

  const diffLines = sanitizeRowDisplayText(event.diff)
    .split('\n')
    .filter((line) => line.length > 0);
  if (!expanded || diffLines.length === 0) {
    rows.push(
      row({
        key: `${keyPrefix}-collapsed`,
        text: `▸ ${event.file} (+${event.linesAdded} -${event.linesRemoved})  Ctrl+D`,
        tone: 'textDim',
      }),
    );
    return rows;
  }

  rows.push(
    row({
      key: `${keyPrefix}-expanded`,
      text: `▾ ${event.file} (+${event.linesAdded} -${event.linesRemoved})  Ctrl+D`,
      tone: 'textDim',
    }),
  );
  const maxLines = getMaxVisibleDiffLines(ctx.viewportRows);
  const visibleLines = diffLines.slice(0, maxLines);
  for (const [index, line] of visibleLines.entries()) {
    rows.push(
      row({
        key: `${keyPrefix}-diff-${index}`,
        text: `${String(index + 1).padStart(3, '0')} ${line}`,
        tone: diffLineTone(line),
      }),
    );
  }
  const remaining = diffLines.length - visibleLines.length;
  if (remaining > 0)
    rows.push(
      row({ key: `${keyPrefix}-remaining`, text: `...${remaining} more lines`, tone: 'textDim' }),
    );
  return rows;
}

export function runningImplementerRows(
  keyPrefix: string,
  event: Extract<EngineEvent, { type: 'implementer_generate_running' }>,
  streaming: StreamingOutputState,
): ConversationRow[] {
  const fileHint = event.file ? `generating ${event.file}...` : 'generating...';
  const rows = [row({ key: `${keyPrefix}-running`, text: fileHint, tone: 'implementer' })];
  if (streaming.active && streaming.taskId === event.taskId) {
    for (const [index, line] of streaming.lines.slice(0, 5).entries()) {
      rows.push(row({ key: `${keyPrefix}-stream-${index}`, text: line, tone: 'textDim' }));
    }
  }
  return rows;
}

function diffLineTone(line: string): ConversationRowTone {
  if (line.startsWith('+ ')) return 'success';
  if (line.startsWith('- ')) return 'error';
  return 'textDim';
}
