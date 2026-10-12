import { simpleGit, type SimpleGit } from 'simple-git';
import { error } from '../../utils/error.js';
import { toErrorMessage } from '../../utils/format-errors.js';
import { resolveBareCommandOnPath } from '../process/command-path.js';

// simple-git rejects a binary outside its custom-binary rule; keep the bare name then.
const SIMPLE_GIT_BINARY_PATTERN = /^([a-z]:)?([a-z0-9/.\\_~-]+)$/i;

let cachedGitBinary: { path: string | undefined; binary: string } | undefined;

export function gitBinary(): string {
  const path = process.env.PATH;
  if (cachedGitBinary === undefined || cachedGitBinary.path !== path) {
    cachedGitBinary = {
      path,
      binary: resolveBareCommandOnPath('git', process.cwd(), path ?? '') ?? 'git',
    };
  }
  return cachedGitBinary.binary;
}

// The user's own remote access settings; simple-git strips every other guarded variable.
const REMOTE_ACCESS_ENVIRONMENT = [
  'GIT_ALLOW_PROTOCOL',
  'GIT_PROTOCOL_FROM_USER',
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  'GIT_SSH_VARIANT',
  'GIT_ASKPASS',
  'SSH_ASKPASS',
  'GIT_TERMINAL_PROMPT',
  'GIT_PROXY_COMMAND',
  'GIT_PROXY_SSL_CAINFO',
  'GIT_PROXY_SSL_CERT',
  'GIT_PROXY_SSL_CERT_PASSWORD_PROTECTED',
  'GIT_PROXY_SSL_KEY',
  'GIT_SSL_CAINFO',
  'GIT_SSL_CAPATH',
  'GIT_SSL_CERT',
  'GIT_SSL_CERT_PASSWORD_PROTECTED',
  'GIT_SSL_CIPHER_LIST',
  'GIT_SSL_KEY',
  'GIT_SSL_NO_VERIFY',
  'GIT_SSL_VERSION',
  'GIT_HTTP_LOW_SPEED_LIMIT',
  'GIT_HTTP_LOW_SPEED_TIME',
  'GIT_HTTP_MAX_REQUESTS',
  'GIT_HTTP_PROXY_AUTHMETHOD',
  'GIT_HTTP_USER_AGENT',
  'GIT_CURL_FTP_NO_EPSV',
  'GIT_LFS_SKIP_SMUDGE',
  'GIT_LFS_SKIP_DOWNLOAD_ERRORS',
];

const getGit = (dir: string): SimpleGit => {
  const resolved = gitBinary();
  const binary = SIMPLE_GIT_BINARY_PATTERN.test(resolved) ? resolved : 'git';
  return simpleGit(dir, { binary, allowEnvironment: REMOTE_ACCESS_ENVIRONMENT });
};

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
