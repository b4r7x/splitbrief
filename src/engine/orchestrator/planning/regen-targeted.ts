import type { Task } from '../../../core/schemas/task.js';

export function buildTargetedRejectionComment(flaggedTasks: Task[]): string {
  if (flaggedTasks.length === 0) return '';

  const taskLines = flaggedTasks.map(t => `- ${t.id}: "${t.title}" (${t.file})`).join('\n');

  return [
    'The user has flagged the following tasks for regeneration:',
    '',
    taskLines,
    '',
    'Please regenerate ONLY these tasks. Keep all other tasks unchanged.',
    'Produce improved versions that address the same goals but with better implementation approach.',
  ].join('\n');
}