import { existsSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { simpleGit, type SimpleGit } from 'simple-git';

const getGit = (dir: string): SimpleGit => simpleGit(dir);

function getStatusPaths(status: Awaited<ReturnType<SimpleGit['status']>>): string[] {
  return status.files.map((file) => file.path);
}

export async function isGitRepo(dir: string): Promise<boolean> {
  const git = getGit(dir);
  return git.checkIsRepo();
}

export async function commitChanges(dir: string, message: string): Promise<string> {
  const git = getGit(dir);
  // Intentional: the orchestrator expects all implementation changes to be staged
  await git.add('.');
  const result = await git.commit(message);
  return result.commit;
}

export async function getCurrentDiff(dir: string): Promise<string> {
  const git = getGit(dir);
  const [staged, unstaged] = await Promise.all([
    git.diff(['--cached']),
    git.diff(),
  ]);
  return [staged, unstaged].filter(Boolean).join('\n');
}

export async function hasExternalChanges(dir: string): Promise<boolean> {
  const git = getGit(dir);
  const status = await git.status();
  return getStatusPaths(status).length > 0;
}

export async function getChangedFiles(dir: string): Promise<string[]> {
  const git = getGit(dir);
  const status = await git.status();
  return getStatusPaths(status);
}

export function ensureGitignore(projectDir: string, entry: string): void {
  const gitignorePath = join(projectDir, '.gitignore');
  if (existsSync(gitignorePath)) {
    const content = readFileSync(gitignorePath, 'utf-8');
    if (content.split('\n').some(line => line.trim() === entry)) return;
    const prefix = content.endsWith('\n') ? '' : '\n';
    appendFileSync(gitignorePath, `${prefix}${entry}\n`);
  } else {
    writeFileSync(gitignorePath, `${entry}\n`);
  }
}

