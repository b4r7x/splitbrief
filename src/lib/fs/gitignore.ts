import { writeFileSync, existsSync, readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertWritablePathConfined } from './confinement.js';
import { rejectSymlinkTarget } from './secure.js';

function getWritableGitignorePath(projectDir: string): string {
  const gitignorePath = join(projectDir, '.gitignore');
  rejectSymlinkTarget(gitignorePath);
  assertWritablePathConfined('.gitignore', projectDir);
  return gitignorePath;
}

export function ensureGitignore(projectDir: string, entry: string): boolean {
  const gitignorePath = getWritableGitignorePath(projectDir);
  if (existsSync(gitignorePath)) {
    const content = readFileSync(gitignorePath, 'utf-8');
    const normalizedEntry = entry.replace(/^\//, '');
    const coveringRules = normalizedEntry.endsWith('/')
      ? [normalizedEntry, `${normalizedEntry}*`, `${normalizedEntry}**`]
      : [normalizedEntry];
    const lines = content.split('\n');
    if (lines.some((line) => coveringRules.includes(line.trim().replace(/^\//, '')))) return false;
    const exceptionIndex = normalizedEntry.endsWith('/')
      ? lines.findIndex((line) => {
          const rule = line.trim().replace(/^!\//, '!');
          return (
            rule.startsWith(`!${normalizedEntry}`) || rule === `!${normalizedEntry.slice(0, -1)}`
          );
        })
      : -1;
    getWritableGitignorePath(projectDir);
    if (exceptionIndex >= 0) {
      lines.splice(exceptionIndex, 0, `${entry}*`);
      writeFileSync(gitignorePath, lines.join('\n'));
      return true;
    }
    const prefix = content.endsWith('\n') ? '' : '\n';
    appendFileSync(gitignorePath, `${prefix}${entry}\n`);
  } else {
    getWritableGitignorePath(projectDir);
    writeFileSync(gitignorePath, `${entry}\n`);
  }
  return true;
}
