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
  notFound: (slug: string) =>
    error('worktree-not-found', `Worktree ".trees/${slug}" does not exist.`, { slug }),
  liveSession: (slug: string, sessionId: string) =>
    error(
      'worktree-live-session',
      `Worktree ".trees/${slug}" has a live session ${sessionId}. Stop the session first, or use --force.`,
      { slug, sessionId },
    ),
  uncommittedChanges: (slug: string) =>
    error(
      'worktree-uncommitted-changes',
      `Worktree ".trees/${slug}" has uncommitted changes. Commit or stash them, or use --force.`,
      { slug },
    ),
  treesPathEscape: () =>
    error(
      'worktree-trees-path-escape',
      'Worktree directory ".trees" resolves outside the project root.',
    ),
} as const;
