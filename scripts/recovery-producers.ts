import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { RECOVERY_REASONS, RETIRED_RECOVERY_REASONS } from '../src/core/schemas/enums.js';

const SOURCE_PATTERN = /\.tsx?$/;
const TEST_PATTERN = /\.test\.tsx?$/;

function engineSources(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) return engineSources(path);
    return SOURCE_PATTERN.test(entry.name) && !TEST_PATTERN.test(entry.name) ? [path] : [];
  });
}

/**
 * Every live recovery cause is raised somewhere in the engine, and no retired one is: a cause
 * nothing raises belongs in the retired list, which keeps only what old files need to parse.
 */
export function findRecoveryProducerViolations(
  root: string = process.cwd(),
  reasons: Readonly<{ live: readonly string[]; retired: readonly string[] }> = {
    live: RECOVERY_REASONS,
    retired: RETIRED_RECOVERY_REASONS,
  },
): string[] {
  const text = engineSources(resolve(root, 'src/engine'))
    .map((file) => readFileSync(file, 'utf-8'))
    .join('\n');
  const named = (reason: string): boolean => text.includes(`'${reason}'`);
  return [
    ...reasons.live
      .filter((reason) => !named(reason))
      .map((reason) => `${reason}: a live recovery cause with no producer under src/engine`),
    ...reasons.retired
      .filter(named)
      .map((reason) => `${reason}: a retired recovery cause still named under src/engine`),
  ];
}

function isMainModule(): boolean {
  return process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isMainModule()) {
  for (const violation of findRecoveryProducerViolations()) console.log(violation);
}
