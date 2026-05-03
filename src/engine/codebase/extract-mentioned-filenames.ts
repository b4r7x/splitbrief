import { existsSync } from 'node:fs';
import { basename, isAbsolute, resolve } from 'node:path';

const PATH_PATTERN = /(?:\.{1,2}\/)?(?:[\w./-]+\/)?[\w-]+\.(tsx|ts|jsx|js|py|go|rs)\b/g;

export function extractMentionedFilenames(
  text: string,
  projectDir: string,
  discoveredFiles?: string[],
): string[] {
  const matches = text.match(PATH_PATTERN) ?? [];
  const results: string[] = [];
  for (const m of matches) {
    const abs = isAbsolute(m) ? m : resolve(projectDir, m);
    if (existsSync(abs)) {
      results.push(m);
      continue;
    }
    if (discoveredFiles) {
      const base = basename(m);
      const found = discoveredFiles.find(f => basename(f) === base);
      if (found) results.push(found);
    }
  }
  return results;
}
