import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import YAML from 'yaml';
import { copyScenarioFixture } from '../../../evals/runner.js';
import { addEndpointScenario } from '../../../evals/scenarios/add-endpoint.js';
import { SPLITBRIEF_DIR, sessionDir, sessionsRoot } from '../../../src/core/paths.js';
import type { Config } from '../../../src/core/schemas/config.js';
import { readActive } from '../../../src/core/sessions/active-pointer.js';
import { reapOrphanRunners } from '../../../src/engine/orchestrator/run/orphan-reaper.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { catalogTool, type LiveCrew } from './live-harness.js';
import { type FixtureRow, resolveFixtureRowSeats } from '../live/fixture-rows.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');

const SKIP_DIRS: ReadonlySet<string> = new Set(['node_modules', SPLITBRIEF_DIR, '.git']);

export type FixtureRunResult = Readonly<{
  exitCode: number | null;
  stdout: string;
  stderr: string;
  projectDir: string;
  sessionDir: string;
  durationMs: number;
  tmpDir: string;
}>;

export async function runFixtureRow(row: FixtureRow): Promise<FixtureRunResult> {
  if (process.env.SPLITBRIEF_REAL_CLI_E2E !== '1') {
    throw new Error('Live fixture row invoked without SPLITBRIEF_REAL_CLI_E2E=1.');
  }
  const { tmpDir, projectDir } = copyScenarioFixture(addEndpointScenario, 'baseline');
  const { stateHome } = seedLiveProject({
    tmpDir,
    projectDir,
    files: collectRepoFiles(projectDir),
    crew: resolveFixtureRowSeats(row),
  });

  const startedAt = Date.now();
  const outcome = await spawnCli({
    args: [
      '--import',
      'tsx',
      'src/cli.ts',
      'start',
      '--plain',
      '--allow-unverified-auth',
      '--project',
      projectDir,
      row.feature,
    ],
    stateHome,
    timeoutMs: row.timeoutMs,
    reapProjectDir: projectDir,
  });

  return {
    ...outcome,
    projectDir,
    sessionDir: resolveSessionDir(projectDir),
    durationMs: Date.now() - startedAt,
    tmpDir,
  };
}

/**
 * Commits `files` with a `.gitignore` for node_modules, writes the crew's `npm test` config, and
 * makes the CLI's state home under `tmpDir`.
 */
export function seedLiveProject(opts: {
  tmpDir: string;
  projectDir: string;
  files: Readonly<Record<string, string>>;
  crew: LiveCrew;
  workflow?: Partial<Config['workflow']> | undefined;
}): { stateHome: string; config: Config } {
  const { crew } = opts;
  // No trailing slash: `copyScenarioFixture` links node_modules, and git reads a
  // symlink as a file, which a directory-only pattern never matches.
  createTestGitRepo(opts.projectDir, { '.gitignore': 'node_modules\n', ...opts.files });
  const config = makeConfig({
    planner: { kind: 'cli', tool: catalogTool(crew.plan.tool), model: crew.plan.model },
    implementer: { kind: 'cli', tool: catalogTool(crew.build.tool), model: crew.build.model },
    reviewer: { kind: 'cli', tool: catalogTool(crew.review.tool), model: crew.review.model },
    validation: { endChecks: true, testCommand: 'npm test' },
    workflow: { approve: 'none', ...opts.workflow },
  });
  mkdirSync(join(opts.projectDir, SPLITBRIEF_DIR), { recursive: true });
  writeFileSync(
    join(opts.projectDir, SPLITBRIEF_DIR, 'config.yaml'),
    YAML.stringify(config),
    'utf-8',
  );
  const stateHome = join(opts.tmpDir, 'state');
  mkdirSync(stateHome, { recursive: true });
  return { stateHome, config };
}

function collectRepoFiles(root: string, prefix = ''): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) Object.assign(files, collectRepoFiles(root, path));
    else if (entry.isFile()) files[path] = readFileSync(join(root, path), 'utf-8');
  }
  return files;
}

export function spawnCli(opts: {
  args: readonly string[];
  stateHome: string;
  timeoutMs: number;
  /**
   * The fixture project whose runner-pid ledger belongs to this CLI. A deadline
   * or abort kill takes down the CLI's group only; runner tools start in groups of their
   * own that the process watchdog ends only later, so once the CLI has closed
   * its ledger is reaped before the run settles.
   */
  reapProjectDir?: string | undefined;
  /**
   * The group leader's pid, handed over as soon as it exists. The resolved value
   * arrives only once the child has closed, which is too late to signal a run
   * that is still going.
   */
  onSpawn?: ((pid: number | undefined) => void) | undefined;
  /** Kills the CLI's group like the deadline does. */
  signal?: AbortSignal | undefined;
}): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((settle) => {
    const child = spawn(process.execPath, [...opts.args], {
      cwd: REPO_ROOT,
      env: { ...process.env, XDG_STATE_HOME: opts.stateHome },
      stdio: 'pipe',
      // Detached so one signal to the group reaches the CLI and every child that
      // shares its group. Runner tools start in groups of their own that the watchdog ends later.
      detached: true,
    });
    opts.onSpawn?.(child.pid);
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    let killed = false;
    const kill = () => {
      killed = true;
      killTree(child.pid);
    };
    const deadline = setTimeout(kill, opts.timeoutMs);
    opts.signal?.addEventListener('abort', kill, { once: true });
    child.on('close', (code) => {
      clearTimeout(deadline);
      opts.signal?.removeEventListener('abort', kill);
      const outcome = { exitCode: code, stdout, stderr };
      const reapProjectDir = killed ? opts.reapProjectDir : undefined;
      if (reapProjectDir === undefined) {
        settle(outcome);
        return;
      }
      // Settle only after the reap: the caller's teardown contract is that the
      // fixture's runner groups are gone once this promise resolves.
      void reapOrphanRunners(reapProjectDir).then(
        () => settle(outcome),
        () => settle(outcome),
      );
    });
  });
}

function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // The group is already gone; the close handler settles the run either way.
  }
}

/** A completed run clears `.splitbrief/active`, so the newest session dir is the fallback. */
export function resolveSessionDir(projectDir: string): string {
  const active = readActive(projectDir);
  if (active !== null) return sessionDir(projectDir, active);
  const root = sessionsRoot(projectDir);
  const newest = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, entry.name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  if (newest === undefined) {
    throw new Error(`Live fixture run wrote no session directory under ${root}.`);
  }
  return newest;
}
