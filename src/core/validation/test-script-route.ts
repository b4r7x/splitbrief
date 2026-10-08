import { existsSync, readFileSync } from 'node:fs';
import { join, matchesGlob } from 'node:path';
import { parseShellCommand } from '../../utils/parse-shell-command.js';
import { isRecord } from '../../utils/type-guards.js';
import { readPackageJson } from '../project-meta.js';
import type { ResolvedCommand } from './stage-command.js';

type ConfigGlobs = { include: string[]; exclude: string[] };

function flagValues(tokens: readonly string[], flag: string): string[] {
  return tokens.flatMap((token, index) => {
    if (token === flag) {
      const value = tokens[index + 1];
      return value === undefined ? [] : [value];
    }
    return token.startsWith(`${flag}=`) ? [token.slice(flag.length + 1)] : [];
  });
}

function vitestSelection(
  script: string,
  projectDir: string,
): { configPath: string; projects: string[] } | null {
  const tokens = parseShellCommand(script);
  const runner = tokens[0] === 'npx' ? tokens.slice(1) : tokens;
  if (runner[0] !== 'vitest' || !(runner[1] === 'run' || runner.includes('--run'))) return null;
  const configPath =
    flagValues(runner, '--config')[0] ??
    ['vitest.config.ts', 'vitest.config.mts', 'vitest.config.js', 'vitest.config.mjs'].find(
      (path) => existsSync(join(projectDir, path)),
    );
  if (configPath === undefined) return null;
  return { configPath: join(projectDir, configPath), projects: flagValues(runner, '--project') };
}

function globs(source: string, key: 'include' | 'exclude'): string[] {
  return [...source.matchAll(new RegExp(`\\b${key}:\\s*\\[([^\\]]*)\\]`, 'g'))].flatMap((list) =>
    [...(list[1] ?? '').matchAll(/['"`]([^'"`]+)['"`]/g)].flatMap((match) =>
      match[1] === undefined ? [] : [match[1]],
    ),
  );
}

function projectSource(source: string, name: string): string | null {
  const match = [...source.matchAll(/\bname\s*:\s*(['"])([^'"]+)\1/g)].find(
    (entry) => entry[2] === name,
  );
  if (match === undefined) return null;
  let depth = 0;
  let start = match.index - 1;
  for (; start >= 0; start--) {
    if (source[start] === '}') depth++;
    if (source[start] === '{') {
      if (depth === 0) break;
      depth--;
    }
  }
  if (start < 0) return null;
  depth = 0;
  for (let end = start; end < source.length; end++) {
    if (source[end] === '{') depth++;
    if (source[end] === '}') {
      depth--;
      if (depth === 0) return source.slice(start, end + 1);
    }
  }
  return null;
}

function readConfigGlobs(path: string, projects: readonly string[]): ConfigGlobs[] {
  if (!existsSync(path)) return [];
  const source = readFileSync(path, 'utf-8');
  const sources =
    projects.length === 0
      ? [source]
      : projects.flatMap((name) => {
          const selected = projectSource(source, name);
          return selected === null ? [] : [selected];
        });
  return sources.map((selected) => ({
    include: globs(selected, 'include'),
    exclude: globs(selected, 'exclude'),
  }));
}

function reaches(config: ConfigGlobs, target: string): boolean {
  return (
    config.include.some((glob) => matchesGlob(target, glob)) &&
    !config.exclude.some((glob) => matchesGlob(target, glob))
  );
}

// Targets the package `test` script cannot reach go to the one-shot `test:<name>`
// vitest script whose --config and --project selection reaches them all.
export function routeTestScript(opts: {
  projectDir: string;
  resolved: ResolvedCommand;
  targets: readonly string[];
}): ResolvedCommand | null {
  const { projectDir, resolved, targets } = opts;
  if (resolved.cmd !== 'npm' || resolved.args.join(' ') !== 'test' || targets.length === 0) {
    return null;
  }
  const scripts = readPackageJson(projectDir)?.['scripts'];
  if (!isRecord(scripts)) return null;
  const primary =
    typeof scripts['test'] === 'string' ? vitestSelection(scripts['test'], projectDir) : null;
  if (primary !== null) {
    const configs = readConfigGlobs(primary.configPath, primary.projects);
    if (targets.every((target) => configs.some((config) => reaches(config, target)))) return null;
  }
  for (const [name, script] of Object.entries(scripts)) {
    if (!name.startsWith('test:') || typeof script !== 'string') continue;
    const selection = vitestSelection(script, projectDir);
    if (selection === null) continue;
    const configs = readConfigGlobs(selection.configPath, selection.projects);
    if (targets.every((target) => configs.some((config) => reaches(config, target)))) {
      return { cmd: 'npm', args: ['run', name], source: resolved.source };
    }
  }
  return null;
}
