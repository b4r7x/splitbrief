import { simpleGit, type SimpleGit } from 'simple-git';
import { error } from '../../utils/error.js';
import { toErrorMessage } from '../../utils/format-errors.js';

const getGit = (dir: string): SimpleGit => simpleGit(dir);

export type GitClient = SimpleGit;

export function createGitClient(dir: string): GitClient {
  return getGit(dir);
}

export function getGitForDir(dir: string): SimpleGit {
  return getGit(dir);
}

export const gitError = {
  commandFailed: (intent: string, causeMessage: string, cause?: unknown) =>
    error(
      'git-command-failed',
      `git ${intent} failed: ${causeMessage}`,
      { intent, causeMessage },
      cause,
    ),
  branchNameCollision: (desiredName: string) =>
    error('git-branch-name-collision', `too many branch name collisions on ${desiredName}`, {
      desiredName,
    }),
} as const;

export type GitCommandError = ReturnType<typeof gitError.commandFailed>;

function toGitCommandError(intent: string, err: unknown): GitCommandError {
  return gitError.commandFailed(intent, toErrorMessage(err), err);
}

export async function runGit<T>(intent: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw toGitCommandError(intent, err);
  }
}

export function parseNulSeparated(output: string): string[] {
  return output.split('\0').filter(Boolean);
}
