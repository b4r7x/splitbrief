import { simpleGit } from 'simple-git';

export async function createCheckpoint(dir: string, label: string): Promise<string> {
  const git = simpleGit(dir);
  await git.add('.');
  const stashSha = (await git.raw(['stash', 'create', `diptych checkpoint: ${label}`])).trim();
  if (!stashSha) return '';
  const tagName = `diptych/${label}`;
  await git.tag([tagName, stashSha]);
  await git.reset();
  return tagName;
}

export async function discardTaskChanges(dir: string, taskFile: string, action: 'create' | 'modify'): Promise<void> {
  const git = simpleGit(dir);
  if (action === 'modify') {
    await git.checkout(['--', taskFile]);
  } else {
    await git.clean('f', ['--', taskFile]);
  }
}
