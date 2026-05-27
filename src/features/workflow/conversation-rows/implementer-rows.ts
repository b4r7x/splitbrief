import { getMaxVisibleDiffLines } from '../../../core/layout/diff-height.js';
import type { EngineEvent } from '../../../engine/events/types.js';
import type { StreamingOutputState } from '../../../stores/workflow/streaming-output.js';
import { formatDuration } from '../../../utils/format-time.js';
import type { ConversationRow, ConversationRowTone, RowBuildContext } from './types.js';
import { row } from './row-format.js';

export function implementerDoneRows(
  keyPrefix: string,
  event: Extract<EngineEvent, { type: 'implementer_generate_done' }>,
  ctx: RowBuildContext,
  expanded: boolean,
): ConversationRow[] {
  const rows = [
    row(`${keyPrefix}-header`, `${event.file}  ${formatDuration(event.duration)}`, 'implementer'),
  ];

  if (!event.diff) {
    rows.push(row(`${keyPrefix}-summary`, `  ${event.file} (+${event.linesAdded} -${event.linesRemoved})`, 'textDim'));
    return rows;
  }

  const diffLines = event.diff.split('\n').filter(line => line.length > 0);
  if (!expanded || diffLines.length === 0) {
    rows.push(row(`${keyPrefix}-collapsed`, `  ▸ ${event.file} (+${event.linesAdded} -${event.linesRemoved})  Ctrl+D`, 'textDim'));
    return rows;
  }

  rows.push(row(`${keyPrefix}-expanded`, `  ▾ ${event.file} (+${event.linesAdded} -${event.linesRemoved})  Ctrl+D`, 'textDim'));
  const maxLines = getMaxVisibleDiffLines(ctx.viewportRows);
  const visibleLines = diffLines.slice(0, maxLines);
  for (const [index, line] of visibleLines.entries()) {
    rows.push(row(`${keyPrefix}-diff-${index}`, `    ${String(index + 1).padStart(3, ' ')} ${line}`, diffLineTone(line)));
  }
  const remaining = diffLines.length - visibleLines.length;
  if (remaining > 0) rows.push(row(`${keyPrefix}-remaining`, `    ...${remaining} more lines`, 'textDim'));
  return rows;
}

export function runningImplementerRows(
  keyPrefix: string,
  event: Extract<EngineEvent, { type: 'implementer_generate_running' }>,
  streaming: StreamingOutputState,
): ConversationRow[] {
  const fileHint = event.file ? `generating ${event.file}...` : 'generating...';
  const rows = [row(`${keyPrefix}-running`, fileHint, 'implementer')];
  if (streaming.active && streaming.taskId === event.taskId) {
    for (const [index, line] of streaming.lines.slice(0, 5).entries()) {
      rows.push(row(`${keyPrefix}-stream-${index}`, `  ${line}`, 'textDim'));
    }
  }
  return rows;
}

function diffLineTone(line: string): ConversationRowTone {
  if (line.startsWith('+ ')) return 'success';
  if (line.startsWith('- ')) return 'error';
  return 'textDim';
}
