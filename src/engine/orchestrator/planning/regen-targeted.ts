import type { Task } from '../../../core/schemas/task.js';

export function buildTargetedRejectionComment(flaggedTasks: Task[]): string {
  if (flaggedTasks.length === 0) return '';

  const taskLines = flaggedTasks.map((t) => `- ${t.id}: "${t.title}" (${t.file})`).join('\n');

  return [
    'The user has flagged the following tasks for regeneration:',
    '',
    taskLines,
    '',
    'Please regenerate ONLY these tasks. Keep all other tasks unchanged.',
    'For each flagged task, keep the same goal and revise the description, scope, tests, and implementation steps to address the user feedback.',
  ].join('\n');
}
