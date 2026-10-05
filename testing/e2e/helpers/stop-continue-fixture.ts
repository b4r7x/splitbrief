import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import YAML from 'yaml';
import { SPLITBRIEF_IDENTITY } from '../../../src/core/identity.js';
import { ISOLATION_TREES_DIR, SPLITBRIEF_DIR } from '../../../src/core/paths.js';
import type { Config } from '../../../src/core/schemas/config.js';
import { canSignalProcess } from '../../../src/lib/process/liveness.js';
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

/** How long the first implementer holds if the continuation never reaps it; a backstop, not a pace. */
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
 * run can be signalled mid-step with the anchor still missing; the continuation's orphan reaper
 * is what ends that hold in the exercised path, and teardown's release bounds it on failure.
 * Every later invocation is a replay: it writes both declared files at once and finishes, which
 * is what lets the same fixture serve the interrupted first attempt and the resumed one.
 */
function implementerHoldScript(tmpDir: string): string {
  const releasePath = join(tmpDir, 'release-implementer');
  const pidPath = join(tmpDir, 'implementer-hold.pid');
  const exitPath = join(tmpDir, 'implementer-hold-exited');
  const invocationsPath = join(tmpDir, 'implementer-invocations');
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
  /** Written by the first implementer once it has left its hold, whether reaped or released. */
  implementerExitPath: string;
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

const APPLY_TIMEOUT_MS = 60_000;

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
    YAML.stringify(fixtureConfig()),
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
  };
}

function fixtureConfig(): Config {
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
    validation: { typecheck: false, lint: false, test: false, testCommand: 'node --version' },
    workflow: { approve: 'none', maxRetries: 1 },
  });
}
