import { lstatSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every entry of a checkout outside `.git` and `.splitbrief`, keyed by path: a
 * link by its target, a file by its mode and bytes. Two equal results mean the
 * run wrote nothing the user would see.
 */
export function checkoutEntries(projectDir: string, prefix = ''): Record<string, string> {
  const result: Record<string, string> = {};
  for (const entry of readdirSync(join(projectDir, prefix), { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === '.splitbrief') continue;
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isSymbolicLink()) result[path] = `link:${readlinkSync(join(projectDir, path))}`;
    else if (entry.isDirectory()) Object.assign(result, checkoutEntries(projectDir, path));
    else
      result[path] =
        `${lstatSync(join(projectDir, path)).mode & 0o777}:${readFileSync(join(projectDir, path)).toString('base64')}`;
  }
  return result;
}
