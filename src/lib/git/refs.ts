import { getGitForDir, gitError, runGit } from './client.js';
import { hasCommits } from './repository.js';

export const GIT_EMPTY_TREE_HASH = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export type RunStartBase =
  | { kind: 'commit'; ref: string }
  | { kind: 'empty-tree'; ref: typeof GIT_EMPTY_TREE_HASH }
  | { kind: 'working-tree-only' };

export async function resolveRunStartBase(opts: {
  projectDir: string;
  head: string | null;
}): Promise<RunStartBase> {
  const { projectDir, head } = opts;
  if (head === null) {
    return (await hasCommits(projectDir))
      ? { kind: 'empty-tree', ref: GIT_EMPTY_TREE_HASH }
      : { kind: 'working-tree-only' };
  }
  await runGit(`rev-parse --verify ${head}^{commit}`, () =>
    getGitForDir(projectDir).raw(['rev-parse', '--verify', `${head}^{commit}`]),
  );
  return { kind: 'commit', ref: head };
}

export async function getCurrentCommitSha(dir: string): Promise<string> {
  const sha = (
    await runGit('rev-parse HEAD', () => getGitForDir(dir).raw(['rev-parse', 'HEAD']))
  ).trim();
  if (sha.length === 0) {
    throw gitError.commandFailed('rev-parse HEAD', 'rev-parse HEAD returned empty output');
  }
  return sha;
}

export async function getCurrentBranch(dir: string): Promise<string> {
  return runGit('rev-parse --abbrev-ref HEAD', async () =>
    (await getGitForDir(dir).raw(['rev-parse', '--abbrev-ref', 'HEAD'])).trim(),
  );
}

export async function branchExists(dir: string, name: string): Promise<boolean> {
  return runGit('branch --list', async () => {
    const result = await getGitForDir(dir).branch(['--list', name]);
    return result.all.includes(name);
  });
}

export async function createBranch(dir: string, desiredName: string): Promise<string> {
  let name = desiredName;
  let suffix = 2;
  while (await branchExists(dir, name)) {
    if (suffix > 99) {
      throw gitError.branchNameCollision(desiredName);
    }
    name = `${desiredName}-${suffix}`;
    suffix++;
  }
  await runGit('checkout -b', () => getGitForDir(dir).checkoutLocalBranch(name));
  return name;
}

export async function showFileAtHead(dir: string, file: string): Promise<string | null> {
  try {
    return await getGitForDir(dir).show([`HEAD:${file}`]);
  } catch {
    return null;
  }
}

export async function showFileAtRef(
  dir: string,
  ref: string,
  file: string,
): Promise<string | null> {
  try {
    return await getGitForDir(dir).show([`${ref}:${file}`]);
  } catch {
    return null;
  }
}

export function restoreFileFromRef(dir: string, ref: string, file: string): Promise<void> {
  return runGit(`checkout ${ref} -- ${file}`, () =>
    getGitForDir(dir).checkout([ref, '--', file]),
  ).then(() => undefined);
}

export function resetIndexEntryToRef(dir: string, ref: string, file: string): Promise<void> {
  return runGit(`reset ${ref} -- ${file}`, () => getGitForDir(dir).reset([ref, '--', file])).then(
    () => undefined,
  );
}
