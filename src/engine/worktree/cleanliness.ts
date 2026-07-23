import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DIPTYCH_DIR, TREES_DIR } from '../../core/paths.js';
import { showFileAtHead } from '../../lib/git/refs.js';

const DIPTYCH_GITIGNORE_LINES = new Set([`${DIPTYCH_DIR}/`, `${TREES_DIR}/`]);

async function readGitignoreSafe(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf-8');
  } catch {
    return null;
  }
}

export async function gitignoreDiffersOnlyByDiptychBookkeeping(
  projectDir: string,
): Promise<boolean> {
  const working = await readGitignoreSafe(join(projectDir, '.gitignore'));
  if (working === null) return false;
  const head = (await showFileAtHead(projectDir, '.gitignore')) ?? '';
  const stripDiptych = (text: string): string[] =>
    text.split('\n').filter((line) => !DIPTYCH_GITIGNORE_LINES.has(line.trim()));
  return stripDiptych(working).join('\n') === stripDiptych(head).join('\n');
}

export function shouldIgnoreSourceDirtyPath(
  path: string,
  gitignoreOnlyBookkeeping: boolean,
): boolean {
  if (path === TREES_DIR || path.startsWith(`${TREES_DIR}/`)) return true;
  if (path === '.gitignore' && gitignoreOnlyBookkeeping) return true;
  return false;
}

export function shouldIgnoreWorktreeUncommittedPath(
  path: string,
  gitignoreOnlyBookkeeping: boolean,
): boolean {
  return path === '.gitignore' && gitignoreOnlyBookkeeping;
}
