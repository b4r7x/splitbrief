import { error } from '../../utils/error.js';

export type WorktreeStatus = 'active' | 'idle' | 'none';

export const worktreeError = {
  nameRequired: () => error('worktree-name-required', 'Worktree name is required.'),
  nameTooLong: (name: string) =>
    error('worktree-name-too-long', `Worktree name "${name}" is too long (max 64 characters).`, {
      name,
    }),
  nameBadPrefix: (name: string) =>
    error('worktree-name-bad-prefix', `Worktree name "${name}" must not start with "." or "-".`, {
      name,
    }),
  nameReserved: (name: string) =>
    error('worktree-name-reserved', `Worktree name "${name}" is reserved.`, { name }),
  nameHasPathSeparator: (name: string) =>
    error(
      'worktree-name-path-separator',
      `Worktree name "${name}" must not contain path separators.`,
      { name },
    ),
  nameInvalidCharacters: (name: string) =>
    error(
      'worktree-name-invalid-characters',
      `Worktree name "${name}" contains invalid characters. Allowed: letters, digits, "_", "-", "." (after the first character).`,
      { name },
    ),
  sourceDirty: (files: string[]) =>
    error(
      'worktree-source-dirty',
      `Source working tree is dirty (${files.length} uncommitted file(s): ${files.join(', ')}). Commit, stash, or clean changes before using --worktree.`,
      { files },
    ),
  branchExists: (branch: string) =>
    error(
      'worktree-branch-exists',
      `Branch ${branch} already exists. Use --worktree <other-name>, or run "git worktree prune" then "git branch -D ${branch}" to clear a stale registration.`,
      { branch },
    ),
  notFound: (label: string) =>
    error('worktree-not-found', `Worktree "${label}" does not exist.`, { label }),
  liveSession: (label: string, sessionId: string) =>
    error(
      'worktree-live-session',
      `Worktree "${label}" has a live session ${sessionId}. Stop the session first, or use --force.`,
      { label, sessionId },
    ),
  uncommittedChanges: (label: string) =>
    error(
      'worktree-uncommitted-changes',
      `Worktree "${label}" has uncommitted changes. Commit or stash them, or use --force.`,
      { label },
    ),
  treesPathEscape: () =>
    error(
      'worktree-trees-path-escape',
      'Worktree directory ".trees" resolves outside the project root.',
    ),
  isolationPathEscape: () =>
    error(
      'worktree-isolation-path-escape',
      'Isolation worktree directory resolves outside the external isolation trees root.',
    ),
  isolationPathOverlap: () =>
    error(
      'worktree-isolation-path-overlap',
      'Isolation worktree directory overlaps the project root or repository git root.',
    ),
} as const;
