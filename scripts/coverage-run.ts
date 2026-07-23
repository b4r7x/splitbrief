import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface CoverageRunPathOptions {
  coverageDir?: string;
  nowMs?: number;
  pid?: number;
}

export interface PruneCoverageRunsOptions {
  coverageDir?: string;
  keep?: number;
  protectedRunDir?: string;
}

export interface CoveragePruneResult {
  kept: string[];
  removed: string[];
}

const ACTIVE_FILE_SUFFIX = '.active';
const DEFAULT_COVERAGE_DIR = 'coverage';
const DEFAULT_KEEP = 5;
const RUN_DIR_PATTERN = /^run-(\d+)(?:-(\d+))?$/;

interface CoverageRun {
  path: string;
  name: string;
  sequence: number;
  pid: number;
  isActive: boolean;
}

export function coverageRunDirectory(opts: CoverageRunPathOptions = {}): string {
  const coverageDir = opts.coverageDir ?? DEFAULT_COVERAGE_DIR;
  const nowMs = opts.nowMs ?? Date.now();
  const pid = opts.pid ?? process.pid;
  return join(coverageDir, `run-${nowMs}-${pid}`);
}

function parseRunDirectory(name: string): { sequence: number; pid: number } | null {
  const match = RUN_DIR_PATTERN.exec(name);
  if (match === null || match[1] === undefined) return null;

  return {
    sequence: Number.parseInt(match[1], 10),
    pid: match[2] === undefined ? 0 : Number.parseInt(match[2], 10),
  };
}

function listCoverageRuns(coverageDir: string): CoverageRun[] {
  if (!existsSync(coverageDir)) return [];

  const runs: CoverageRun[] = [];
  for (const entry of readdirSync(coverageDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;

    const parsed = parseRunDirectory(entry.name);
    if (parsed === null) continue;

    const runPath = resolve(coverageDir, entry.name);
    runs.push({
      path: runPath,
      name: entry.name,
      sequence: parsed.sequence,
      pid: parsed.pid,
      isActive: existsSync(activeFileForRun(runPath)),
    });
  }
  return runs;
}

function activeFileForRun(runDir: string): string {
  return join(dirname(runDir), `.${basename(runDir)}${ACTIVE_FILE_SUFFIX}`);
}

function newestFirst(a: CoverageRun, b: CoverageRun): number {
  if (a.sequence !== b.sequence) return b.sequence - a.sequence;
  if (a.pid !== b.pid) return b.pid - a.pid;
  return b.name.localeCompare(a.name);
}

export function pruneCoverageRuns(opts: PruneCoverageRunsOptions = {}): CoveragePruneResult {
  const coverageDir = resolve(opts.coverageDir ?? DEFAULT_COVERAGE_DIR);
  const keep = opts.keep ?? DEFAULT_KEEP;
  const protectedRunDir = opts.protectedRunDir === undefined ? null : resolve(opts.protectedRunDir);
  const runs = listCoverageRuns(coverageDir).sort(newestFirst);
  const retained = new Set(runs.slice(0, keep).map((run) => run.path));
  const kept: string[] = [];
  const removed: string[] = [];

  for (const run of runs) {
    const shouldKeep =
      retained.has(run.path) || run.isActive || run.path === protectedRunDir || keep < 0;
    if (shouldKeep) {
      kept.push(run.path);
      continue;
    }

    rmSync(run.path, { recursive: true, force: true });
    removed.push(run.path);
  }

  return { kept, removed };
}

function coverageKeepFromEnv(): number {
  const raw = process.env.DIPTYCH_COVERAGE_KEEP;
  if (raw === undefined) return DEFAULT_KEEP;

  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_KEEP;
}

function markActive(runDir: string): void {
  mkdirSync(runDir, { recursive: true });
  writeFileSync(activeFileForRun(runDir), `${process.pid}\n`, 'utf-8');
}

function clearActive(runDir: string): void {
  rmSync(activeFileForRun(runDir), { force: true });
}

function runVitestCoverage(runDir: string, args: readonly string[]): number {
  const vitestBin = process.platform === 'win32' ? 'vitest.cmd' : 'vitest';
  const maxWorkers = process.env.DIPTYCH_COVERAGE_MAX_WORKERS ?? '2';
  const retry = process.env.DIPTYCH_COVERAGE_RETRY ?? '0';
  const vitestArgs = ['run', '--coverage', `--maxWorkers=${maxWorkers}`, ...args];
  if (retry !== '0') vitestArgs.splice(2, 0, `--retry=${retry}`);
  const result = spawnSync(vitestBin, vitestArgs, {
    env: { ...process.env, DIPTYCH_COVERAGE_DIR: runDir },
    stdio: 'inherit',
  });

  if (result.error !== undefined) {
    console.error(result.error.message);
    return 1;
  }
  if (result.signal !== null) return 1;
  return result.status ?? 1;
}

function isMainModule(): boolean {
  return process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isMainModule()) {
  const coverageDir = resolve(process.env.DIPTYCH_COVERAGE_ROOT ?? DEFAULT_COVERAGE_DIR);
  const keep = coverageKeepFromEnv();
  const passthroughArgs = process.argv.slice(2).filter((arg) => arg !== '--prune');

  if (process.argv.includes('--prune')) {
    const result = pruneCoverageRuns({ coverageDir, keep });
    for (const removed of result.removed) {
      console.log(`removed ${basename(removed)}`);
    }
    process.exit(0);
  }

  const runDir = resolve(process.env.DIPTYCH_COVERAGE_DIR ?? coverageRunDirectory({ coverageDir }));

  markActive(runDir);
  pruneCoverageRuns({ coverageDir, keep, protectedRunDir: runDir });

  let status = 1;
  try {
    status = runVitestCoverage(runDir, passthroughArgs);
  } finally {
    clearActive(runDir);
    pruneCoverageRuns({ coverageDir, keep, protectedRunDir: runDir });
  }

  process.exit(status);
}
