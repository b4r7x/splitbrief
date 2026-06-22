import type { Task } from '../../../../core/schemas/task.js';
import { sanitizeTerminalDisplayText } from '../../../../utils/display-text.js';

export function compactValue(value: string | number | undefined): string {
  if (value === undefined || value === '') return 'pending';
  return sanitizeTaskDisplayText(String(value));
}

export function compactExcerpt(text: string): string {
  return sanitizeTerminalDisplayText(text, { preserveLineBreaks: true })
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' / ');
}

export function sanitizeTaskDisplayText(text: string): string {
  return sanitizeTerminalDisplayText(text);
}

export function sanitizeTaskDisplayBlock(text: string): string {
  return sanitizeTerminalDisplayText(text, { preserveLineBreaks: true });
}

export function sanitizeTaskDisplayItems(items: readonly string[] | undefined): string[] {
  return (items ?? []).map(sanitizeTaskDisplayText);
}

export function taskWithoutCurrentCode(task: Task): Task {
  const { currentCode: _currentCode, ...withoutCurrentCode } = task;
  return withoutCurrentCode;
}
