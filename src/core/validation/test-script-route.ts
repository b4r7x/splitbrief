import { existsSync, readFileSync } from 'node:fs';
import { join, matchesGlob } from 'node:path';
import { parseShellCommand } from '../../utils/parse-shell-command.js';
import { isRecord } from '../../utils/type-guards.js';
import { readPackageJson } from '../project-meta.js';
import type { ResolvedCommand } from './stage-command.js';

type ConfigGlobs = { include: string[]; exclude: string[] };

function vitestConfigPath(script: string): string | null {
  const tokens = parseShellCommand(script);
  const runner = tokens[0] === 'npx' ? tokens.slice(1) : tokens;
  if (runner[0] !== 'vitest') return null;
  const flag = runner.indexOf('--config');
  if (flag !== -1) return runner[flag + 1] ?? null;
  return runner.find((token) => token.startsWith('--config='))?.slice('--config='.length) ?? null;
}

function globs(source: string, key: 'include' | 'exclude'): string[] {
  return [...source.matchAll(new RegExp(`\\b${key}:\\s*\\[([^\\]]*)\\]`, 'g'))].flatMap((list) =>
    [...(list[1] ?? '').matchAll(/['"`]([^'"`]+)['"`]/g)].flatMap((match) =>
      match[1] === undefined ? [] : [match[1]],
    ),
  );
}

function readConfigGlobs(path: string): ConfigGlobs | null {
  if (!existsSync(path)) return null;
  const source = readFileSync(path, 'utf-8');
  return { include: globs(source, 'include'), exclude: globs(source, 'exclude') };
}

function reaches(config: ConfigGlobs, target: string): boolean {
  return (
    config.include.some((glob) => matchesGlob(target, glob)) &&
    !config.exclude.some((glob) => matchesGlob(target, glob))
  );
}

// The package `test` script runs one vitest config; a file only a `test:<name>`
// script's own `--config` includes is reachable through that script alone.
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
  for (const [name, script] of Object.entries(scripts)) {
    if (!name.startsWith('test:') || typeof script !== 'string') continue;
    const configPath = vitestConfigPath(script);
    if (configPath === null) continue;
    const config = readConfigGlobs(join(projectDir, configPath));
    if (config !== null && targets.every((target) => reaches(config, target))) {
      return { cmd: 'npm', args: ['run', name], source: resolved.source };
    }
  }
  return null;
}
