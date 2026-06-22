import {
  getTerminalCellWidth,
  truncateTerminalDisplayText,
  truncateTerminalDisplayTextMiddle,
} from '../../../utils/display-text.js';

const DEFAULT_MIN_TITLE_WIDTH = 16;
const DEFAULT_MIN_FILE_WIDTH = 12;
const DEFAULT_MAX_FILE_FRACTION = 0.36;
const MAX_TASK_ID_WIDTH = 8;
const MIN_TASK_ID_WIDTH = 4;
const MAX_TASK_STATUS_WIDTH = 10;
const MIN_TASK_STATUS_WIDTH = 7;

export interface TaskIdentityPartsInput {
  width: number;
  prefix?: string | undefined;
  flag?: string | undefined;
  statusSymbol: string;
  taskId: string;
  status: string;
  file: string;
  title: string;
  minTitleWidth?: number | undefined;
  minFileWidth?: number | undefined;
}

export interface TaskIdentityParts {
  prefix: string;
  flag: string;
  statusSymbol: string;
  taskId: string;
  status: string;
  file: string;
  title: string;
}

function clampBudget(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

function textWidth(text: string): number {
  return getTerminalCellWidth(text);
}

export function formatTaskIdentityParts(input: TaskIdentityPartsInput): TaskIdentityParts {
  const width = Math.max(0, Math.floor(input.width));
  const prefix = input.prefix ?? '';
  const flag = input.flag ?? '';
  const statusSymbol = `${input.statusSymbol} `;
  const taskIdBudget = clampBudget(textWidth(input.taskId), MIN_TASK_ID_WIDTH, MAX_TASK_ID_WIDTH);
  const statusBudget = clampBudget(
    textWidth(input.status),
    MIN_TASK_STATUS_WIDTH,
    MAX_TASK_STATUS_WIDTH,
  );
  const taskId = truncateTerminalDisplayText(input.taskId, taskIdBudget);
  const status = truncateTerminalDisplayText(input.status, statusBudget);
  const baseWidth =
    textWidth(prefix) +
    textWidth(flag) +
    textWidth(statusSymbol) +
    textWidth(taskId) +
    1 +
    textWidth(status);
  const titleCells = textWidth(input.title);
  const titleOnlyBudget = Math.max(0, width - baseWidth - 1);
  const minTitleWidth = Math.min(
    input.minTitleWidth ?? DEFAULT_MIN_TITLE_WIDTH,
    titleCells,
    titleOnlyBudget,
  );
  const fileCells = textWidth(input.file);
  const minFileWidth = Math.min(input.minFileWidth ?? DEFAULT_MIN_FILE_WIDTH, fileCells);
  const availableWithFile = Math.max(0, width - baseWidth - 2);

  if (fileCells === 0 || availableWithFile < minTitleWidth + minFileWidth) {
    return {
      prefix,
      flag,
      statusSymbol,
      taskId,
      status,
      file: '',
      title: truncateTerminalDisplayText(input.title, titleOnlyBudget),
    };
  }

  const maxFileWidth = Math.min(
    fileCells,
    Math.max(minFileWidth, Math.floor(width * DEFAULT_MAX_FILE_FRACTION)),
  );
  const fileWidth = Math.min(maxFileWidth, availableWithFile - minTitleWidth);
  const titleWidth = Math.max(0, availableWithFile - fileWidth);

  return {
    prefix,
    flag,
    statusSymbol,
    taskId,
    status,
    file: truncateTerminalDisplayTextMiddle(input.file, fileWidth),
    title: truncateTerminalDisplayText(input.title, titleWidth),
  };
}
