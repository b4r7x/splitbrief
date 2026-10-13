import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import YAML from 'yaml';
import { SPLITBRIEF_IDENTITY } from '../../../src/core/identity.js';
import {
  ISOLATION_TREES_DIR,
  SPLITBRIEF_DIR,
  STATE_FILE,
  sessionDir,
} from '../../../src/core/paths.js';
import type { Config } from '../../../src/core/schemas/config.js';
import type { IsolationStrategy } from '../../../src/core/schemas/enums.js';
import {
  type PersistedWorkflowState,
  type WorkflowState,
  WorkflowStateSchema,
} from '../../../src/core/schemas/workflow.js';
import { readActive } from '../../../src/core/sessions/active-pointer.js';
import { loadConfig } from '../../../src/core/config/load/io.js';
import { plainUserMessage } from '../../../src/core/types/user-input.js';
import { parseContinueActionOption } from '../../../src/cli/options.js';
import { canonicalizeProjectDir } from '../../../src/cli/setup.js';
import { applyRecoveryAction } from '../../../src/engine/orchestrator/recovery/actions.js';
import { createRecoveryBus } from '../../../src/engine/orchestrator/recovery/bus.js';
import { runWorkflow } from '../../../src/engine/orchestrator/run/workflow.js';
import { prepareExecution } from '../../../src/engine/runners/prepare-execution/prepare-execution.js';
import { canSignalProcess } from '../../../src/lib/process/liveness.js';
import { TEST_WORKFLOW_SINKS } from '#testing/helpers/orchestrator-context.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { passingVerdict } from '#testing/helpers/typed-planner.js';
import { spawnCli } from './live-cli-harness.js';

/** The brief's anchor: written by the orchestrator from the implementer's reply. */
export const GREET_FILE = 'src/greet.ts';

/**
 * The brief's second declared file, written by the implementer process itself
 * before it holds the call open. It is the partial output a cut attempt leaves
 * behind, and the progress marker the test waits on before it signals the run.
 */
export const MARKER_FILE = 'src/marker.ts';

export const MARKER_SOURCE = "export const RUN_MARKER = 'implementer-started';\n";

/** The implementer writes this verbatim, so it is byte-for-byte what lands on disk. */
export const GREET_SOURCE = `export function greet(name: string): string {
  return name === '' ? 'hello' : \`hello \${name}\`;
}`;

/** How long the first implementer holds if no signal or release ends it; a backstop, not a pace. */
const IMPLEMENTER_HOLD_MS = 180_000;

/** How long teardown waits for the held implementer to leave, or to die after a signal. */
const HOLD_EXIT_TIMEOUT_MS = 5_000;

/** The planning session's one typed answer: a plan with the single greeting brief. */
const PLAN_ANSWER = {
  result: {
    kind: 'plan',
    summary: 'Add a standalone greeting helper plus the run marker constant beside it.',
    decisions: [],
    criteria: [{ id: 'C1', text: 'greet returns a greeting', checkIds: ['T001-K1', 'T001-K2'] }],
    checks: [],
    validation: null,
    tasks: [
      {
        id: 'T001',
        title: 'Add a greeting helper',
        intent: 'Add a standalone greeting helper plus the run marker constant beside it.',
        criteria: ['C1'],
        checks: [
          { id: 'T001-K1', kind: 'test', value: "greet('a') === 'hello a'", required: true },
          { id: 'T001-K2', kind: 'test', value: "greet('') === 'hello'", required: true },
        ],
        suggestedFiles: [GREET_FILE, MARKER_FILE],
        contextFiles: [],
        exclusions: ['everything else'],
        protectedOperations: null,
        steps: [
          `Create \`${MARKER_FILE}\` exporting \`RUN_MARKER\`.`,
          `Create \`${GREET_FILE}\` exporting \`greet\`.`,
        ],
        dependsOn: [],
        batch: 1,
      },
    ],
  },
};

/** The review's typed answer: the plan's every task met and every criterion passed. */
const REVIEW_REPLY = JSON.stringify(
  passingVerdict({
    kind: 'final',
    taskIds: PLAN_ANSWER.result.tasks.map((task) => task.id),
    criterionIds: PLAN_ANSWER.result.criteria.map((criterion) => criterion.id),
  }),
);

/**
 * Both planner calls of a run reach this one script: the typed plan and the
 * final review. Only `buildFinalReviewPrompt` titles its prompt "Final
 * Implementation Review", so the title is what the script branches on.
 */
const PLANNER_SCRIPT = `const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString('utf-8');

const PLAN = ${JSON.stringify(JSON.stringify(PLAN_ANSWER))};
const REVIEW = ${JSON.stringify(REVIEW_REPLY)};

process.stdout.write(prompt.includes('Final Implementation Review') ? REVIEW : PLAN);
`;

/**
 * The first invocation writes the marker and then holds for the fixture's release file, so the
 * run can be signalled mid-step with the anchor still missing. The CLI's abort ends that hold
 * after a SIGINT and the process watchdog after a SIGKILL; teardown's release bounds it on failure.
 * Every later invocation is a replay: it writes both declared files at once and finishes, which
 * is what lets the same fixture serve the interrupted first attempt and the resumed one.
 */
function implementerHoldScript(tmpDir: string): string {
  const releasePath = join(tmpDir, 'release-implementer');
  const pidPath = join(tmpDir, 'implementer-hold.pid');
  const exitPath = join(tmpDir, 'implementer-hold-exited');
  const invocationsPath = join(tmpDir, 'implementer-invocations');
  const replaySawPartialPath = join(tmpDir, 'replay-saw-partial');
  return `import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

for await (const chunk of process.stdin) void chunk;

const countPath = ${JSON.stringify(invocationsPath)};
let invocations = 0;
try {
  invocations = Number(readFileSync(countPath, 'utf8')) || 0;
} catch {}
writeFileSync(countPath, String(invocations + 1));

if (invocations > 0) {
  writeFileSync(${JSON.stringify(replaySawPartialPath)}, String(existsSync(${JSON.stringify(MARKER_FILE)})));
  mkdirSync('src', { recursive: true });
  writeFileSync(${JSON.stringify(MARKER_FILE)}, ${JSON.stringify(MARKER_SOURCE)});
  writeFileSync(${JSON.stringify(GREET_FILE)}, ${JSON.stringify(GREET_SOURCE)});
  process.exit(0);
}

// The pid first, so teardown can always confirm this process is gone once the marker exists.
writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
mkdirSync('src', { recursive: true });
writeFileSync(${JSON.stringify(MARKER_FILE)}, ${JSON.stringify(MARKER_SOURCE)});
const releasePath = ${JSON.stringify(releasePath)};
const deadline = Date.now() + ${IMPLEMENTER_HOLD_MS};
while (!existsSync(releasePath) && Date.now() < deadline) await delay(50);
writeFileSync(${JSON.stringify(exitPath)}, '');
`;
}

export type StopContinueFixture = Readonly<{
  tmpDir: string;
  projectDir: string;
  stateHome: string;
  /**
   * Where the run's isolation worktrees land under this fixture's state home. The implementer
   * writes there, and nothing reaches `projectDir` until the run is applied, so this is the
   * only place a write before Apply is visible.
   */
  isolationTreesDir: string;
  markerPath: string;
  greetPath: string;
  /** Creating this file releases a first implementer still holding; teardown does it. */
  releaseHoldPath: string;
  /** The first implementer's pid, written before its hold begins. */
  implementerPidPath: string;
  /** Written by the first implementer when a release or its deadline ends its hold, not on a signal. */
  implementerExitPath: string;
  /** Written by a replay before it writes: `true` when the stopped attempt's marker was still there. */
  replaySawPartialPath: string;
}>;

/** Releases a first implementer still holding, so teardown never leaves the handshake open. */
export function releaseImplementerHold(fixture: StopContinueFixture): void {
  writeFileSync(fixture.releaseHoldPath, '');
}

/**
 * Ends the fixture's implementer hold and confirms the held process is gone before the
 * caller deletes the fixture directory. Releasing alone is racy: the release file lives
 * inside the directory cleanup removes, and the child polls it every 50 ms, so a delete
 * that wins the race leaves the process holding until its deadline. A process that will
 * not leave on release is terminated and its exit awaited.
 */
export async function endImplementerHold(fixture: StopContinueFixture): Promise<void> {
  releaseImplementerHold(fixture);
  let pid: number;
  try {
    pid = Number(readFileSync(fixture.implementerPidPath, 'utf8'));
  } catch {
    // The first implementer never started, so no process holds the handshake.
    return;
  }
  if (!Number.isInteger(pid) || pid <= 0) return;
  const deadline = Date.now() + HOLD_EXIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (existsSync(fixture.implementerExitPath) || !canSignalProcess(pid)) return;
    await delay(25);
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // It exited between the last liveness check and the signal.
  }
  const killDeadline = Date.now() + HOLD_EXIT_TIMEOUT_MS;
  while (canSignalProcess(pid) && Date.now() < killDeadline) await delay(10);
}

/**
 * Writes both declared files at once — and creates a branch in the checkout the
 * run promotes into, around the isolation directory it was given. `git branch`
 * refuses a name that exists, so only the first attempt changes the checkout.
 * The checkout's path is baked in; the implementer never learns it.
 */
export function escapingImplementerScript(checkoutDir: string): string {
  return `import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

for await (const chunk of process.stdin) void chunk;

spawnSync('git', ['-C', ${JSON.stringify(checkoutDir)}, 'branch', ${JSON.stringify(ESCAPED_BRANCH)}]);
mkdirSync('src', { recursive: true });
writeFileSync(${JSON.stringify(MARKER_FILE)}, ${JSON.stringify(MARKER_SOURCE)});
writeFileSync(${JSON.stringify(GREET_FILE)}, ${JSON.stringify(GREET_SOURCE)});
`;
}

/** The branch the escaping implementer leaves in the checkout on its first attempt. */
export const ESCAPED_BRANCH = 'escaped';

const RUN_TIMEOUT_MS = 60_000;
const START_TIMEOUT_MS = 90_000;
const CONTINUE_TIMEOUT_MS = 120_000;
const MARKER_WAIT_MS = 75_000;
const APPLY_TIMEOUT_MS = 60_000;

export function cli(
  target: Pick<StopContinueFixture, 'projectDir' | 'stateHome'>,
  args: readonly string[],
  options: Pick<Parameters<typeof spawnCli>[0], 'timeoutMs' | 'onSpawn'> & {
    json?: boolean;
  } = {
    timeoutMs: RUN_TIMEOUT_MS,
  },
): ReturnType<typeof spawnCli> {
  const diagnostics = args[0] === 'init' || args[0] === 'doctor';
  const oneShot = args[0] === 'spec' || args[0] === 'review';
  const status = args[0] === 'status';
  return spawnCli({
    args: [
      '--import',
      'tsx',
      'src/cli.ts',
      ...args,
      ...(status
        ? []
        : options.json === true
          ? ['--json']
          : diagnostics || oneShot
            ? []
            : ['--plain']),
      ...(diagnostics || status ? [] : ['--allow-repo-runners']),
      '--project',
      target.projectDir,
    ],
    stateHome: target.stateHome,
    ...options,
  });
}

export function startAndSignal(
  target: StopContinueFixture,
  signal: NodeJS.Signals,
  markerDir: string,
): Promise<{ exitCode: number | null; stdout: string; sessionId: string }> {
  return signalWhenMarked(target, ['start', 'smoke'], START_TIMEOUT_MS, signal, markerDir);
}

/** Continues the active run and signals it once its implementer wrote the marker under `markerDir`. */
export function continueAndSignal(
  target: StopContinueFixture,
  signal: NodeJS.Signals,
  markerDir: string,
): Promise<{ exitCode: number | null; stdout: string; sessionId: string }> {
  return signalWhenMarked(target, ['continue'], CONTINUE_TIMEOUT_MS, signal, markerDir);
}

async function signalWhenMarked(
  target: StopContinueFixture,
  args: readonly string[],
  timeoutMs: number,
  signal: NodeJS.Signals,
  markerDir: string,
): Promise<{ exitCode: number | null; stdout: string; sessionId: string }> {
  let groupPid: number | undefined;
  const run = cli(target, args, {
    timeoutMs,
    onSpawn: (pid) => {
      groupPid = pid;
    },
  });

  await waitForMarker(markerDir, MARKER_WAIT_MS);
  if (groupPid === undefined) throw new Error('the CLI reported no pid to signal');
  process.kill(-groupPid, signal);

  const outcome = await run;
  const sessionId = readActive(target.projectDir);
  if (sessionId === null) {
    throw new Error(`the interrupted run left no active session: ${outcome.stderr}`);
  }
  return { exitCode: outcome.exitCode, stdout: outcome.stdout, sessionId };
}

export function continueRun(target: StopContinueFixture): ReturnType<typeof spawnCli> {
  return cli(target, ['continue'], { timeoutMs: CONTINUE_TIMEOUT_MS });
}

/**
 * Continues a run the way the run screen does when the operator types a correction and presses
 * ⏎: the run is re-entered on its saved state, and the words ride the steer into the first step.
 * An `action` answers a pending halt first, as the recovery menu does.
 */
export async function continueWithCorrection(
  target: StopContinueFixture,
  sessionId: string,
  correction: string,
  action?: string,
): Promise<PersistedWorkflowState> {
  // The CLI runs on the canonical project path; the run records its workspace under it.
  const projectDir = await canonicalizeProjectDir({ project: target.projectDir });
  const ref = { projectDir, sessionId };
  const stateHome = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = target.stateHome;
  try {
    let state: WorkflowState = readState(target, sessionId);
    let config = loadConfig(projectDir).config;
    if (action !== undefined) {
      const parsed = parseContinueActionOption(action);
      if (parsed.action === 'apply' || parsed.action === 'discard')
        throw new Error(`'${action}' does not answer a halt`);
      const answered = await applyRecoveryAction({
        projectDir,
        sessionId,
        state,
        action: parsed.action,
        bus: createRecoveryBus({ projectDir, sessionId }),
        config,
        ...(parsed.candidate !== undefined && { candidate: parsed.candidate }),
      });
      if (!answered.ok) throw new Error(answered.message);
      state = answered.state;
      config = answered.switchedConfig ?? config;
    }
    const preparation = await prepareExecution({
      existingSession: ref,
      feature: state.feature,
      effectiveConfig: config,
      policy: {
        purpose: 'resume',
        interaction: 'headless',
        allowRepoRunners: true,
        allowHooks: false,
        unverifiedAuth: 'allowed',
      },
      signal: new AbortController().signal,
      resumeState: state,
    });
    if (preparation.kind !== 'prepared')
      throw new Error(`the resume was not prepared: ${preparation.kind}`);
    await runWorkflow({
      prepared: preparation.execution,
      sinks: TEST_WORKFLOW_SINKS,
      savedState: state,
      steer: plainUserMessage(correction),
      callbacks: {
        onApprovalNeeded: async () => ({ approved: true }),
        onComplete: () => undefined,
      },
    });
    return readState(target, sessionId);
  } finally {
    process.env.XDG_STATE_HOME = stateHome;
  }
}

async function waitForMarker(dir: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (findMarker(dir) !== null) return;
    await delay(100);
  }
  throw new Error(`the implementer never wrote ${MARKER_FILE} under ${dir} within ${timeoutMs}ms`);
}

export function findMarker(dir: string): string | null {
  if (!existsSync(dir)) return null;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isFile() && path.endsWith(MARKER_FILE)) return path;
    if (entry.isDirectory() && entry.name !== '.git') {
      const found = findMarker(path);
      if (found !== null) return found;
    }
  }
  return null;
}

export function readState(target: StopContinueFixture, sessionId: string): PersistedWorkflowState {
  const file = join(sessionDir(target.projectDir, sessionId), STATE_FILE);
  return WorkflowStateSchema.parse(JSON.parse(readFileSync(file, 'utf-8')));
}

/** Applies a run that is ready to apply the way an operator does from the shell. */
export function applyRun(
  fixture: StopContinueFixture,
  sessionId: string,
): ReturnType<typeof spawnCli> {
  return spawnCli({
    args: [
      '--import',
      'tsx',
      'src/cli.ts',
      'continue',
      sessionId,
      '--action',
      'apply',
      '--plain',
      '--project',
      fixture.projectDir,
    ],
    stateHome: fixture.stateHome,
    timeoutMs: APPLY_TIMEOUT_MS,
  });
}

/**
 * A throwaway repository whose planner and implementer are local node scripts,
 * so the whole stop → continue → finish path runs without a model call.
 */
export function createStopContinueFixture(
  implementerScript?: (projectDir: string) => string,
  options: { isolation?: IsolationStrategy } = {},
): StopContinueFixture {
  const tmpDir = mkdtempSync(join(tmpdir(), 'splitbrief-stop-continue-'));
  const projectDir = join(tmpDir, 'project');
  mkdirSync(projectDir, { recursive: true });
  const script = implementerScript ?? (() => implementerHoldScript(tmpDir));

  createTestGitRepo(projectDir, {
    '.gitignore': 'node_modules\n',
    'tools/planner.mjs': PLANNER_SCRIPT,
    'tools/implementer.mjs': script(projectDir),
  });

  mkdirSync(join(projectDir, SPLITBRIEF_DIR), { recursive: true });
  writeFileSync(
    join(projectDir, SPLITBRIEF_DIR, 'config.yaml'),
    YAML.stringify(fixtureConfig(options.isolation)),
    'utf-8',
  );

  const stateHome = join(tmpDir, 'state');
  mkdirSync(stateHome, { recursive: true });

  return {
    tmpDir,
    projectDir,
    stateHome,
    isolationTreesDir: join(stateHome, SPLITBRIEF_IDENTITY.slug, ISOLATION_TREES_DIR),
    markerPath: join(projectDir, MARKER_FILE),
    greetPath: join(projectDir, GREET_FILE),
    releaseHoldPath: join(tmpDir, 'release-implementer'),
    implementerPidPath: join(tmpDir, 'implementer-hold.pid'),
    implementerExitPath: join(tmpDir, 'implementer-hold-exited'),
    replaySawPartialPath: join(tmpDir, 'replay-saw-partial'),
  };
}

function fixtureConfig(isolation?: IsolationStrategy): Config {
  return makeConfig({
    planner: {
      kind: 'shell',
      command: 'node',
      args: ['./tools/planner.mjs'],
      outputFormat: 'text',
      capabilities: {
        supportsConversationalPlanning: false,
        supportsSessionResume: false,
      },
    },
    implementer: {
      kind: 'agent',
      command: 'node',
      args: ['./tools/implementer.mjs'],
      outputFormat: 'text',
      model: 'fixture',
      // A fixture model has no catalog window, and routing refuses a profile it cannot prove
      // the brief fits: without this the run halts on context-overflow before the script runs.
      contextLength: 200_000,
    },
    // The plan's `test` checks are prose; a command that exits 0 lets them run without a project test script.
    validation: { endChecks: false, testCommand: 'node --version' },
    workflow: {
      approve: 'none',
      ...(isolation !== undefined ? { isolation } : {}),
    },
  });
}
