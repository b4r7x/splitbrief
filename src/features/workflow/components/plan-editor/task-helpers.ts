import type { Task } from '../../../../core/schemas/task.js';

export function compactValue(value: string | number | undefined): string {
  return value === undefined || value === '' ? 'pending' : String(value);
}

export function compactExcerpt(text: string): string {
  return text.split('\n').map(line => line.trim()).filter(Boolean).join(' / ');
}

export function taskWithoutCurrentCode(task: Task): Task {
  const { currentCode: _currentCode, ...withoutCurrentCode } = task;
  return withoutCurrentCode;
}
