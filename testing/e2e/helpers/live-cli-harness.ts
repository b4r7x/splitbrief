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
import { catalogTool } from './live-harness.js';
import {
  type FixtureRow,
  type FixtureRowSeats,
  resolveFixtureRowSeats,
} from '../live/fixture-rows.js';

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
  const seats = resolveFixtureRowSeats(row);
  const { tmpDir, projectDir } = copyScenarioFixture(addEndpointScenario, 'baseline');
  // No trailing slash: `copyScenarioFixture` links node_modules, and git reads a
  // symlink as a file, which a directory-only pattern never matches.
  createTestGitRepo(projectDir, {
    '.gitignore': 'node_modules\n',
    ...collectRepoFiles(projectDir),
  });
  mkdirSync(join(projectDir, SPLITBRIEF_DIR), { recursive: true });
  writeFileSync(
    join(projectDir, SPLITBRIEF_DIR, 'config.yaml'),
    YAML.stringify(fixtureConfig(seats)),
    'utf-8',
  );
  const stateHome = join(tmpDir, 'state');
  mkdirSync(stateHome, { recursive: true });

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

function fixtureConfig(seats: FixtureRowSeats): Config {
  return makeConfig({
    planner: { kind: 'cli', tool: catalogTool(seats.plan.tool), model: seats.plan.model },
    implementer: { kind: 'cli', tool: catalogTool(seats.build.tool), model: seats.build.model },
    reviewer: { kind: 'cli', tool: catalogTool(seats.review.tool), model: seats.review.model },
    validation: { endChecks: true, testCommand: 'npm test' },
    workflow: {
      approve: 'none',
    },
  });
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
   * kill takes down the CLI's group only; runner tools start in groups of their
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
    let deadlineFired = false;
    const deadline = setTimeout(() => {
      deadlineFired = true;
      killTree(child.pid);
    }, opts.timeoutMs);
    child.on('close', (code) => {
      clearTimeout(deadline);
      const outcome = { exitCode: code, stdout, stderr };
      const reapProjectDir = deadlineFired ? opts.reapProjectDir : undefined;
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
function resolveSessionDir(projectDir: string): string {
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
