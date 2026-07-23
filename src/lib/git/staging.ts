import { getGitForDir, parseNulSeparated, runGit } from './client.js';

export async function stageAll(dir: string): Promise<void> {
  await runGit('add .', () => getGitForDir(dir).add('.'));
}

export async function stageFiles(dir: string, files: string[]): Promise<void> {
  if (files.length === 0) return;
  await runGit('add --', () => getGitForDir(dir).add(['--', ...files]));
}

export async function resetIndex(dir: string): Promise<void> {
  await runGit('reset', () => getGitForDir(dir).reset(['--mixed', 'HEAD']));
}

export async function getStagedFiles(dir: string): Promise<string[]> {
  return runGit('diff --cached --name-only -z', async () =>
    parseNulSeparated(await getGitForDir(dir).diff(['--cached', '--name-only', '-z'])),
  );
}

export async function resetIndexPreservingStaged(
  dir: string,
  stagedBefore: string[],
): Promise<void> {
  await resetIndex(dir);
  await stageFiles(dir, stagedBefore);
}

export async function commitChanges(dir: string, message: string): Promise<string> {
  return runGit('commit', async () => (await getGitForDir(dir).commit(message)).commit);
}

export async function createTaggedStash(
  dir: string,
  message: string,
  tagName: string,
): Promise<string> {
  const stagedBefore = await getStagedFiles(dir);
  await stageAll(dir);
  try {
    return await runGit('stash create', async () => {
      const git = getGitForDir(dir);
      const stashSha = (await git.raw(['stash', 'create', message])).trim();
      if (!stashSha) {
        await resetIndexPreservingStaged(dir, stagedBefore);
        return '';
      }
      try {
        await git.tag([tagName, stashSha]);
      } catch (err) {
        await resetIndexPreservingStaged(dir, stagedBefore);
        throw err;
      }
      await resetIndexPreservingStaged(dir, stagedBefore);
      return tagName;
    });
  } catch (err) {
    try {
      await resetIndexPreservingStaged(dir, stagedBefore);
    } catch {
      // best-effort restore after a failed checkpoint
    }
    throw err;
  }
}
