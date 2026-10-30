import { SOFT_SEP } from '../separators.js';
import { countNoun } from '../../utils/pluralize.js';
import {
  getTerminalCellWidth,
  sanitizeTerminalDisplayText,
  truncateTerminalDisplayText,
} from '../../utils/display-text.js';
import type { WorkflowTask } from './briefs.js';
import type { TaskStartedEvent } from './events.js';

// Both `tasks_planned` and `task_started` carry `file` and `action`, but the resume path rebuilds
// tasks from persisted state that has neither, so a row cannot assume they are there. Rendering the
// pair through this is what stops a missing field reaching the screen as the literal `undefined`.
export function taskTargetParts(
  task: Partial<Pick<TaskStartedEvent, 'file' | 'files' | 'action'>>,
): {
  path: string;
  note: string;
  extraFiles: string;
} {
  if (task.file === undefined || task.file === '') return { path: '', note: '', extraFiles: '' };
  // A slice writes more than one file, and the row has room for one. The anchor is the file the
  // brief is named after; the rest are counted, in their own ` · ` token with the unit spelled, so
  // the count cannot be read as part of the path it follows.
  const extra = (task.files?.length ?? 1) - 1;
  return {
    path: task.file,
    note: task.action === undefined ? '' : `(${task.action})`,
    extraFiles: extra === 0 ? '' : `+${countNoun(extra, 'file')}`,
  };
}

export function taskTargetLabel(task: WorkflowTask): string {
  const { path, note, extraFiles } = taskTargetParts(task);
  const target = note === '' ? path : `${path} ${note}`;
  return [target, extraFiles].filter((part) => part !== '').join(SOFT_SEP);
}

export function formatTaskHeading(
  input: Pick<WorkflowTask, 'id' | 'title'>,
  cells?: number,
): string {
  const safeTitle = sanitizeTerminalDisplayText(input.title);
  const title =
    cells === undefined
      ? safeTitle
      : truncateTerminalDisplayText(safeTitle, cells - getTerminalCellWidth(input.id) - 1);
  return title === '' ? input.id : `${input.id} ${title}`;
}

export function taskRowLabel(task: WorkflowTask, cells: number): string {
  const title = sanitizeTerminalDisplayText(task.title);
  const heading = formatTaskHeading({ id: task.id, title });
  const target = sanitizeTerminalDisplayText(taskTargetLabel(task));
  const label = target === '' ? heading : `${heading}${SOFT_SEP}${target}`;
  if (getTerminalCellWidth(label) <= cells) return label;
  return formatTaskHeading({ id: task.id, title }, cells);
}
