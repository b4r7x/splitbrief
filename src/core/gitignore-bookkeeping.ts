import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SPLITBRIEF_DIR, TREES_DIR } from './paths.js';
import { showFileAtHead } from '../lib/git/refs.js';

const SPLITBRIEF_GITIGNORE_LINES = new Set([`${SPLITBRIEF_DIR}/`, `${TREES_DIR}/`]);

async function readGitignoreSafe(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf-8');
  } catch {
    return null;
  }
}

export async function gitignoreDiffersOnlyBySplitbriefBookkeeping(
  projectDir: string,
): Promise<boolean> {
  const working = await readGitignoreSafe(join(projectDir, '.gitignore'));
  if (working === null) return false;
  const head = (await showFileAtHead(projectDir, '.gitignore'))?.toString('utf8') ?? '';
  // Setup ends a last line that has no newline before it appends its own line, so the final
  // newline is not compared.
  const stripSplitbrief = (text: string): string[] =>
    text
      .replace(/\n$/, '')
      .split('\n')
      .filter((line) => !SPLITBRIEF_GITIGNORE_LINES.has(line.trim()));
  return stripSplitbrief(working).join('\n') === stripSplitbrief(head).join('\n');
}

export function shouldIgnoreWorktreeUncommittedPath(
  path: string,
  gitignoreOnlyBookkeeping: boolean,
): boolean {
  return path === '.gitignore' && gitignoreOnlyBookkeeping;
}
