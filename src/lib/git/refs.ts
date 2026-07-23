import { getGitForDir, gitError, runGit } from './client.js';

export async function getRunStartHead(
  dir: string,
  runCommitMessagePrefix: string,
): Promise<string | null> {
  try {
    const log = await getGitForDir(dir).raw(['log', '--format=%H%x00%s', 'HEAD']);
    for (const line of log.split('\n')) {
      const sep = line.indexOf('\0');
      if (sep === -1) continue;
      const sha = line.slice(0, sep);
      const subject = line.slice(sep + 1);
      if (!subject.startsWith(runCommitMessagePrefix)) return sha;
    }
    return null;
  } catch {
    return null;
  }
}

export async function getCurrentCommitSha(dir: string): Promise<string> {
  return runGit('rev-parse HEAD', async () => {
    const sha = (await getGitForDir(dir).raw(['rev-parse', 'HEAD'])).trim();
    return sha.length > 0 ? sha : 'HEAD';
  });
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

export async function restoreFileFromRef(dir: string, ref: string, file: string): Promise<void> {
  await runGit(`checkout ${ref} -- ${file}`, () => getGitForDir(dir).checkout([ref, '--', file]));
}

export async function resetIndexEntryToRef(dir: string, ref: string, file: string): Promise<void> {
  await runGit(`reset ${ref} -- ${file}`, () => getGitForDir(dir).reset([ref, '--', file]));
}
