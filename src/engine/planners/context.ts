import type { Dirent } from 'node:fs';
import { readFile, readdir, access } from 'node:fs/promises';
import { join } from 'node:path';
import { readPackageJson } from '../../core/project-meta.js';

const MAX_LISTED_ENTRIES = 500;

export async function buildProjectContextMarkdown(projectDir: string): Promise<string> {
  const parts: string[] = [];

  const pkg = readPackageJson(projectDir);
  if (pkg) {
    const name = typeof pkg.name === 'string' ? pkg.name : 'unknown';
    const description = typeof pkg.description === 'string' ? pkg.description : '';
    const rawScripts = (typeof pkg.scripts === 'object' && pkg.scripts !== null && !Array.isArray(pkg.scripts))
      ? pkg.scripts
      : {};

    parts.push(`## Package: ${name}`);
    if (description) parts.push(description);
    const scriptEntries = Object.entries(rawScripts).filter(([, v]) => typeof v === 'string');
    if (scriptEntries.length > 0) {
      parts.push('\n### Scripts');
      for (const [scriptName, cmd] of scriptEntries) {
        parts.push(`- \`${scriptName}\`: \`${cmd}\``);
      }
    }
  }

  const readmePath = join(projectDir, 'README.md');
  try {
    await access(readmePath);
    const readme = await readFile(readmePath, 'utf-8');
    const first50 = readme.split('\n').slice(0, 50).join('\n');
    parts.push('\n## README (first 50 lines)');
    parts.push(first50);
  } catch { /* README missing or unreadable */ }

  const srcDir = join(projectDir, 'src');
  try {
    await access(srcDir);
    parts.push('\n## Source Files');
    const counter = { count: 0 };
    const listing = await listDir(srcDir, projectDir, 0, 4, counter);
    parts.push(listing);
    if (counter.count >= MAX_LISTED_ENTRIES) {
      parts.push(`[... listing truncated at ${MAX_LISTED_ENTRIES} entries]`);
    }
  } catch { /* no src/ directory */ }

  return parts.join('\n');
}

async function listDir(dir: string, root: string, depth: number, maxDepth: number, counter: { count: number }): Promise<string> {
  if (depth >= maxDepth) return '';

  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return '';
  }
  const lines: string[] = [];
  const indent = '  '.repeat(depth);

  for (const entry of entries) {
    if (counter.count >= MAX_LISTED_ENTRIES) break;
    if (entry.name.startsWith('.')) continue;
    if (entry.name === 'node_modules') continue;

    const fullPath = join(dir, entry.name);
    const relPath = fullPath.slice(root.length + 1);

    if (entry.isDirectory()) {
      lines.push(`${indent}${relPath}/`);
      counter.count++;
      const subLines = await listDir(fullPath, root, depth + 1, maxDepth, counter);
      if (subLines) lines.push(subLines);
    } else {
      lines.push(`${indent}${relPath}`);
      counter.count++;
    }
  }

  return lines.join('\n');
}
