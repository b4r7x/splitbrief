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

export function buildBriefQualityRepairComment(errorMessages: readonly string[]): string {
  return [
    'The Task Brief quality gate rejected the briefs you just produced. Every issue below is blocking:',
    '',
    ...errorMessages.map((message) => `- ${message}`),
    '',
    'Regenerate the complete tasks.md so every brief clears the Brief Contract on its own: concrete `### Tests` bullets (required even when a different brief owns the test file — list the cases that verify this brief), `### Scope` bounds, `### Evidence` bullets, and numbered `### Implementation Steps`.',
    'Keep the feature scope, the brief ids, and the dependency links unchanged wherever the issues above do not require otherwise.',
  ].join('\n');
}
