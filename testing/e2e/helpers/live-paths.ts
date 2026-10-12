import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect } from 'vitest';
import { sessionDir, sessionsRoot } from '../../../src/core/paths.js';
import type { Config } from '../../../src/core/schemas/config.js';
import type { WorkflowState } from '../../../src/core/schemas/workflow.js';
import { readActive } from '../../../src/core/sessions/active-pointer.js';
import { PROCESS_START_TOLERANCE_MS } from '../../../src/core/sessions/lockfile-status.js';
import { type RunnerPidEntry, readRunnerPids } from '../../../src/core/sessions/runner-pids.js';
import { loadState } from '../../../src/core/state/persistence.js';
import type { SessionRef } from '../../../src/core/types/session-ref.js';
import { reapOrphanRunners } from '../../../src/engine/orchestrator/run/orphan-reaper.js';
import { readProcessStartTimeMs } from '../../../src/lib/process/start-time.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { resolveReleaseMatrixSeat } from '../live/matrix.js';
import { seedLiveProject, spawnCli } from './live-cli-harness.js';
import { copyLiveArtifacts, type LiveCrew, type LiveSeat, liveModelPin } from './live-harness.js';

/** The crew the owner runs: Claude plans and reviews, OpenCode builds. */
const DEFAULT_CREW: LiveCrew = {
  plan: { tool: 'claude-code', model: 'sonnet' },
  build: { tool: 'opencode', model: 'opencode-go/deepseek-v4.1-flash' },
  review: { tool: 'claude-code', model: 'sonnet' },
};

/** The deadline of each CLI call, and the unit of each scenario's timeout. A real plan, build and review call each take a minute or two. */
export const LIVE_PATHS_TIMEOUT_MS = 600_000;

/** How long a tool process may outlive the CLI that started it. */
export const ORPHAN_BOUND_MS = 10_000;

export function livePathsEnabled(): boolean {
  return process.env.SPLITBRIEF_REAL_CLI_E2E === '1' && process.env.SPLITBRIEF_LIVE_PATHS === '1';
}

function resolveSeat(toolEnv: string, fallback: LiveSeat): LiveSeat {
  const tool = process.env[toolEnv] ?? fallback.tool;
  if (tool !== fallback.tool) return resolveReleaseMatrixSeat(tool);
  return { tool, model: liveModelPin({ tool, fallback: fallback.model }) };
}

/**
 * A seat's tool comes from `SPLITBRIEF_REAL_CLI_PLANNER`, `_IMPLEMENTER` or `_REVIEWER`, and its
 * model from the tool's `SPLITBRIEF_REAL_CLI_<TOOL>_MODEL` pin, under the live cost ceiling.
 */
export function resolveLivePathsCrew(): LiveCrew {
  return {
    plan: resolveSeat('SPLITBRIEF_REAL_CLI_PLANNER', DEFAULT_CREW.plan),
    build: resolveSeat('SPLITBRIEF_REAL_CLI_IMPLEMENTER', DEFAULT_CREW.build),
    review: resolveSeat('SPLITBRIEF_REAL_CLI_REVIEWER', DEFAULT_CREW.review),
  };
}

export type LivePathsFixture = Readonly<{
  files: Readonly<Record<string, string>>;
  feature: string;
  /** A module script run from the project root; it exits 0 when the checkout does what the feature asks. No seat sees it. */
  acceptance: string;
}>;

const PACKAGE_JSON = `${JSON.stringify(
  {
    name: 'live-paths-fixture',
    private: true,
    type: 'module',
    scripts: { test: 'node --test test/*.test.mjs' },
  },
  null,
  2,
)}\n`;

export const SLUGIFY_FIXTURE: LivePathsFixture = {
  files: {
    'package.json': PACKAGE_JSON,
    'src/text.mjs': "export function shout(text) {\n  return text.toUpperCase() + '!';\n}\n",
    'test/text.test.mjs': [
      "import assert from 'node:assert/strict';",
      "import { test } from 'node:test';",
      "import { shout } from '../src/text.mjs';",
      '',
      "test('shout upper-cases and adds an exclamation mark', () => {",
      "  assert.equal(shout('hi'), 'HI!');",
      '});',
      '',
    ].join('\n'),
  },
  feature:
    'Add an exported function slugify(text) to src/text.mjs. It lowercases the text, replaces every run of characters other than a-z and 0-9 with one hyphen, and removes leading and trailing hyphens. Add node:test cases for slugify to test/text.test.mjs. Keep shout unchanged.',
  acceptance: [
    "import assert from 'node:assert/strict';",
    "import { shout, slugify } from './src/text.mjs';",
    "assert.equal(slugify('  Hello, World!  '), 'hello-world');",
    "assert.equal(slugify('a--b'), 'a-b');",
    "assert.equal(slugify('Already-Slug'), 'already-slug');",
    "assert.equal(shout('hi'), 'HI!');",
  ].join('\n'),
};

/** The base fails its own test: `subtotal` ignores the quantity, and the feature does not mention it. */
export const FAILING_BASE_FIXTURE: LivePathsFixture = {
  files: {
    'package.json': PACKAGE_JSON,
    'src/cart.mjs': [
      'export function subtotal(items) {',
      '  return items.reduce((sum, item) => sum + item.price, 0);',
      '}',
      '',
    ].join('\n'),
    'test/cart.test.mjs': [
      "import assert from 'node:assert/strict';",
      "import { test } from 'node:test';",
      "import { subtotal } from '../src/cart.mjs';",
      '',
      "test('subtotal multiplies each price by its quantity', () => {",
      '  assert.equal(subtotal([{ price: 2, qty: 3 }, { price: 5, qty: 1 }]), 11);',
      '});',
      '',
    ].join('\n'),
  },
  feature:
    'Add an exported function applyDiscount(amount, percent) to src/cart.mjs that returns amount reduced by percent percent, rounded to two decimals. Add node:test cases for applyDiscount to test/cart.test.mjs.',
  acceptance: [
    "import assert from 'node:assert/strict';",
    "import { applyDiscount, subtotal } from './src/cart.mjs';",
    'assert.equal(subtotal([{ price: 2, qty: 3 }, { price: 5, qty: 1 }]), 11);',
    'assert.equal(applyDiscount(200, 15), 170);',
    'assert.equal(applyDiscount(19.99, 10), 17.99);',
  ].join('\n'),
};

export type LivePathsProject = Readonly<{
  id: string;
  tmpDir: string;
  projectDir: string;
  /** The CLI's state home; the run workspaces land under it. */
  stateHome: string;
  config: Config;
  /** Stops recording the ledger entries of the project's runs and returns every entry seen; throws when a read failed. */
  stopWatchingRunners: () => RunnerPidEntry[];
  /** Starts a run on the project's abort signal; `disposeLivePathsProject` aborts it if it is still going. */
  startRun: <T>(start: (signal: AbortSignal) => Promise<T>) => Promise<T>;
  /** Aborts every run the project started and resolves once each has settled. */
  abortRuns: () => Promise<void>;
}>;

export function createLivePathsProject(opts: {
  id: string;
  fixture: LivePathsFixture;
  crew: LiveCrew;
  workflow?: Partial<Config['workflow']>;
}): LivePathsProject {
  const tmpDir = createTempDir(`live-paths-${opts.id}`);
  const projectDir = join(tmpDir, 'project');
  const { stateHome, config } = seedLiveProject({
    tmpDir,
    projectDir,
    files: opts.fixture.files,
    crew: opts.crew,
    workflow: opts.workflow,
  });
  const runs = new AbortController();
  return {
    id: opts.id,
    tmpDir,
    projectDir,
    stateHome,
    config,
    stopWatchingRunners: watchRunnerLedgers(projectDir, runs),
    ...trackLiveRuns(runs),
  };
}

/** Starts every run on the signal of `runs`, so a teardown can abort the runs still going and wait for them. */
export function trackLiveRuns(
  runs: AbortController,
): Pick<LivePathsProject, 'startRun' | 'abortRuns'> {
  const settling: Promise<unknown>[] = [];
  return {
    startRun: (start) => {
      const run = start(runs.signal);
      settling.push(run.catch(() => undefined));
      return run;
    },
    abortRuns: async () => {
      runs.abort(new Error('the scenario ended with its run still going'));
      await Promise.all(settling);
    },
  };
}

/**
 * Aborts and settles every run the scenario left going, copies every run's record to
 * `.test-artifacts/live/paths-<id>/<session>`, reaps what the runs left, and removes the project.
 */
export async function disposeLivePathsProject(project: LivePathsProject): Promise<void> {
  try {
    await project.abortRuns();
    for (const sessionId of sessionIds(project.projectDir)) {
      copyLiveArtifacts({
        projectDir: project.projectDir,
        sessionId,
        rowId: `paths-${project.id}/${sessionId}`,
      });
    }
    await reapOrphanRunners(project.projectDir);
  } finally {
    cleanupTempDir(project.tmpDir);
    project.stopWatchingRunners();
  }
}

function sessionIds(projectDir: string): string[] {
  const root = sessionsRoot(projectDir);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

export function livePathsCli(
  project: LivePathsProject,
  args: readonly string[],
  onSpawn?: (pid: number | undefined) => void,
): ReturnType<typeof spawnCli> {
  return project.startRun((signal) =>
    spawnCli({
      args: [
        '--import',
        'tsx',
        'src/cli.ts',
        ...args,
        '--plain',
        '--allow-unverified-auth',
        '--project',
        project.projectDir,
      ],
      stateHome: project.stateHome,
      timeoutMs: LIVE_PATHS_TIMEOUT_MS,
      reapProjectDir: project.projectDir,
      onSpawn,
      signal,
    }),
  );
}

/** Polls `probe` until it holds. Rejects when `ended` settles first; the polling stops either way. */
export async function pollUntil<T>(
  probe: () => T | null,
  opts: { ended: Promise<never>; timeoutMs: number; what: string },
): Promise<T> {
  const controller = new AbortController();
  const poll = async (): Promise<T> => {
    const deadline = Date.now() + opts.timeoutMs;
    while (Date.now() < deadline) {
      const value = probe();
      if (value !== null) return value;
      await delay(250, undefined, { signal: controller.signal });
    }
    throw new Error(`${opts.what} did not happen within ${opts.timeoutMs}ms`);
  };
  try {
    return await Promise.race([opts.ended, poll()]);
  } finally {
    controller.abort();
  }
}

/** The run's state while a BUILD call is live: the brief is being built and a tool process is on the ledger. */
export function buildCallState(ref: SessionRef): WorkflowState | null {
  const state = loadState(ref);
  if (state?.phase !== 'implementing') return null;
  return readRunnerPids(ref).length > 0 ? state : null;
}

/** Starts a run and signals the CLI's group once `probe` holds for its session. */
export async function startAndSignalWhen(
  project: LivePathsProject,
  opts: {
    feature: string;
    signal: NodeJS.Signals;
    probe: (ref: SessionRef) => boolean;
    what: string;
  },
): Promise<{ exitCode: number | null; sessionId: string; stderr: string }> {
  let groupPid: number | undefined;
  const run = livePathsCli(project, ['start', opts.feature], (pid) => {
    groupPid = pid;
  });
  const ended = run.then((outcome) => {
    throw new Error(`the run exited (${outcome.exitCode}) before ${opts.what}:\n${outcome.stderr}`);
  });
  const sessionId = await pollUntil(
    () => {
      const id = readActive(project.projectDir);
      return id !== null && opts.probe({ projectDir: project.projectDir, sessionId: id })
        ? id
        : null;
    },
    { ended, timeoutMs: LIVE_PATHS_TIMEOUT_MS, what: opts.what },
  );
  if (groupPid === undefined) throw new Error('the CLI reported no pid to signal');
  process.kill(-groupPid, opts.signal);
  const outcome = await run;
  return { exitCode: outcome.exitCode, sessionId, stderr: outcome.stderr };
}

/**
 * Records every tool process the project's runs put on their ledgers until the returned stop is
 * called. A failed read leaves the record incomplete: the watcher stops, aborts the runs, and the
 * stop throws the failure.
 */
export function watchRunnerLedgers(
  projectDir: string,
  runs: AbortController,
): () => RunnerPidEntry[] {
  const seen = new Map<string, RunnerPidEntry>();
  let failure: unknown;
  const read = () => {
    for (const sessionId of sessionIds(projectDir)) {
      for (const entry of readRunnerPids({ projectDir, sessionId })) {
        seen.set(`${entry.pid}:${entry.startTimeMs}`, entry);
      }
    }
  };
  const timer = setInterval(() => {
    try {
      read();
    } catch (error) {
      failure = error;
      clearInterval(timer);
      runs.abort(error);
    }
  }, 200);
  return () => {
    clearInterval(timer);
    if (failure !== undefined) {
      throw new Error('the runner ledger watcher failed', { cause: failure });
    }
    read();
    return [...seen.values()];
  };
}

/** The pids of each process group in `ps -A -o pid=,pgid=` output, keyed by group id. */
export function readProcessGroups(psOutput: string): Map<number, number[]> {
  const groups = new Map<number, number[]>();
  for (const line of psOutput.split('\n')) {
    const [pid, pgid] = line.trim().split(/\s+/).map(Number);
    if (pid === undefined || pgid === undefined) continue;
    const pids = groups.get(pgid);
    if (pids === undefined) groups.set(pgid, [pid]);
    else pids.push(pid);
  }
  return groups;
}

/** The ledger's pid now runs a process that started at another time. */
function leaderRecycled(entry: RunnerPidEntry): boolean {
  if (entry.startTimeMs === null) return false;
  const startTimeMs = readProcessStartTimeMs(entry.pid);
  return (
    startTimeMs !== null && Math.abs(startTimeMs - entry.startTimeMs) > PROCESS_START_TOLERANCE_MS
  );
}

/**
 * Waits up to `boundMs` for every process in the groups the ledger entries lead to exit; returns
 * the pids still alive then. A group id is a pid, which the kernel gives out again once the group
 * is empty: a group seen empty once, or whose leader pid now runs a newer process, no longer counts.
 */
export async function survivorsAfter(
  entries: readonly RunnerPidEntry[],
  boundMs: number,
): Promise<number[]> {
  const deadline = Date.now() + boundMs;
  let groups = entries;
  for (;;) {
    const members = readProcessGroups(
      execFileSync('ps', ['-A', '-o', 'pid=,pgid='], { encoding: 'utf-8' }),
    );
    const live: RunnerPidEntry[] = [];
    const alive: number[] = [];
    for (const entry of groups) {
      const pids = members.get(entry.pid);
      if (pids === undefined || leaderRecycled(entry)) continue;
      live.push(entry);
      alive.push(...pids);
    }
    groups = live;
    if (alive.length === 0 || Date.now() >= deadline) return alive;
    await delay(250);
  }
}

export function readRunState(ref: SessionRef): WorkflowState {
  const state = loadState(ref);
  if (state === null) throw new Error(`run ${ref.sessionId} saved no state`);
  return state;
}

export function runSessionDir(ref: SessionRef): string {
  return sessionDir(ref.projectDir, ref.sessionId);
}

/** The checkout holds the feature, its own suite passes, and the hidden acceptance script passes. */
export function expectCheckoutDelivers(projectDir: string, fixture: LivePathsFixture): void {
  const suite = spawnSync('npm', ['test'], { cwd: projectDir, encoding: 'utf-8' });
  expect(suite.status, `npm test in the checkout:\n${suite.stdout}\n${suite.stderr}`).toBe(0);
  const acceptance = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', fixture.acceptance],
    { cwd: projectDir, encoding: 'utf-8' },
  );
  expect(acceptance.status, `acceptance in the checkout:\n${acceptance.stderr}`).toBe(0);
}
