import { SPLITBRIEF_DIR, TREES_DIR } from '../../../../core/paths.js';

export const GITIGNORE_FILE = '.gitignore';
const GITIGNORE_BOOKKEEPING_LINES = new Set([`${SPLITBRIEF_DIR}/`, `${TREES_DIR}/`]);

// Isolation appends these entries to the worktree's own .gitignore, so a bookkeeping
// line the project's copy does not already carry is SPLITBRIEF's and never the task's.
export function stripGitignoreBookkeeping(
  text: string | null,
  projectText: string | null = null,
): string {
  if (text === null) return '';
  const projectLines = new Set((projectText ?? '').split('\n').map((line) => line.trim()));
  return text
    .split('\n')
    .filter((line) => {
      const entry = line.trim();
      return !GITIGNORE_BOOKKEEPING_LINES.has(entry) || projectLines.has(entry);
    })
    .join('\n');
}
