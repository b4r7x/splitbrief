import type { Task } from '../../../core/schemas/task.js';

export function buildTargetedRejectionComment(
  flaggedTasks: Task[],
  reason?: string | undefined,
): string {
  if (flaggedTasks.length === 0) return '';

  const taskLines = flaggedTasks.map((t) => `- ${t.id}: "${t.title}" (${t.file})`).join('\n');
  const trimmedReason = reason?.trim();

  return [
    'The user has flagged the following tasks for regeneration:',
    '',
    taskLines,
    ...(trimmedReason ? ['', `User reason: ${trimmedReason}`] : []),
    '',
    'The Current Task Briefs section lists the full existing task list. Regenerate ONLY the flagged tasks above.',
    'Keep every other task unchanged, including IDs, ordering, and dependency links.',
    'For each flagged task, keep the same goal and revise the description, scope, tests, and implementation steps to address the user feedback.',
  ].join('\n');
}
