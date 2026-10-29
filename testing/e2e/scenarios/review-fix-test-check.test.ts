import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { sessionsRoot } from '../../../src/core/paths.js';
import type { ReviewAnswer } from '../../../src/core/schemas/review.js';
import type { Check } from '../../../src/core/schemas/task.js';
import { readRunEvents } from '../../../src/engine/events/replay.js';
import { activateSafeCliShimPath } from '#testing/helpers/compatible-cli-shim.js';
import { makePlanProposal, makeTaskSpec } from '#testing/helpers/factories/plan.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { passingVerdict } from '#testing/helpers/typed-planner.js';
import {
  cli,
  createStopContinueFixture,
  readState,
  type StopContinueFixture,
} from '../helpers/stop-continue-fixture.js';

const TEST_FILE = 'src/alpha.test.mjs';
const TEST_COMMAND = `node --test ${TEST_FILE}`;

const alpha = makeTaskSpec({
  id: 'T001',
  title: 'Add the alpha values',
  intent: 'Export alpha and its upper-case form loud.',
  criteria: ['C1'],
  suggestedFiles: ['src/alpha.mjs', TEST_FILE],
  checks: [{ id: 'T001-K1', kind: 'test', value: TEST_FILE, required: true }],
});
const fix = makeTaskSpec({
  id: 'T002',
  title: 'Make loud the upper-case alpha',
  intent: 'Export loud as the upper-case alpha value.',
  criteria: ['C1'],
  suggestedFiles: ['src/alpha.mjs'],
  contextFiles: [TEST_FILE],
  checks: [{ id: 'T002-K1', kind: 'test', value: TEST_COMMAND, required: true }],
});
const plan = makePlanProposal({
  summary: 'Add the alpha values.',
  decisions: [],
  criteria: [{ id: 'C1', text: 'Alpha is alpha and loud is ALPHA.', checkIds: ['T001-K1'] }],
  tasks: [alpha],
});
const finding: ReviewAnswer['findings'][number] = {
  id: 'F1',
  kind: 'defect',
  severity: 'blocking',
  taskId: alpha.id,
  criterionId: 'C1',
  file: 'src/alpha.mjs',
  line: null,
  text: 'loud is not the upper-case alpha.',
  acceptance: 'loud is ALPHA.',
  checkIds: null,
};
const refusedCheck = `Check T002-K1 is refused: a \`test\` check names one test file, and \`${TEST_COMMAND}\` is not one file.`;
const NEW_TEST_FILE = 'src/loud.test.mjs';
const LOUD_TEST_GUIDANCE = `Write ${NEW_TEST_FILE}: the check runs it.`;

let fixture: StopContinueFixture | undefined;
let restorePath: (() => void) | undefined;

afterEach(() => {
  restorePath?.();
  vi.unstubAllEnvs();
  if (fixture !== undefined) cleanupTempDir(fixture.tmpDir);
  fixture = undefined;
  restorePath = undefined;
});

function git(cwd: string, args: readonly string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

/**
 * The final review fails until the fix task T002 exists. Its first fix task carries `refused` as
 * its check; the repair names the test file.
 */
function plannerScript(callsPath: string, refused: Check = fix.checks[0] as Check): string {
  const passing = passingVerdict({ kind: 'final', taskIds: [], criterionIds: [] });
  return `import { appendFileSync } from 'node:fs';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString('utf8');
let kind;
let answer;
if (prompt.includes('# Choose the checks for this review')) {
  kind = 'review-checks';
  answer = null;
} else if (prompt.includes('# Final Implementation Review')) {
  const repair = prompt.includes('It failed validation:');
  kind = repair ? 'final-review-repair' : 'final-review';
  const ids = (label) => prompt.match(new RegExp('^' + label + ' (.+)$', 'm'))[1].split(',').map((id) => id.trim());
  const taskIds = ids('Task ids:');
  const fails = !taskIds.includes('T002');
  answer = {
    ...${JSON.stringify(passing)},
    tasks: taskIds.map((id) => ({ id, plan: fails ? 'partial' : 'met', note: '' })),
    criteria: ids('Criterion ids:').map((id) => ({ id, status: fails ? 'fail' : 'pass', evidence: '' })),
  };
  if (fails) {
    const fix = ${JSON.stringify(fix)};
    answer.findings = [${JSON.stringify(finding)}];
    answer.fixTasks = [{
      ...fix,
      checks: [repair ? { ...fix.checks[0], value: ${JSON.stringify(TEST_FILE)} } : ${JSON.stringify(refused)}],
      findingIds: ['F1'],
    }];
  }
} else if (prompt.includes('# Plan the change')) {
  kind = 'plan';
  answer = ${JSON.stringify({ result: plan })};
} else {
  throw new Error('Unexpected prompt: ' + prompt);
}
appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ kind, prompt }) + '\\n');
process.stdout.write(JSON.stringify(answer));
`;
}

/** The fix brief also writes the loud test when its prompt carries the review seat's guidance. */
function implementerScript(): string {
  const writes = {
    [alpha.title]: {
      'src/alpha.mjs': "export const alpha = 'alpha';\nexport const loud = 'alpha';\n",
      [TEST_FILE]:
        "import { strict as assert } from 'node:assert';\nimport { alpha } from './alpha.mjs';\nassert.equal(alpha, 'alpha');\n",
    },
    [fix.title]: {
      'src/alpha.mjs': "export const alpha = 'alpha';\nexport const loud = 'ALPHA';\n",
    },
  };
  const loudTest =
    "import { strict as assert } from 'node:assert';\nimport { loud } from './alpha.mjs';\nassert.equal(loud, 'ALPHA');\n";
  return `import { mkdirSync, writeFileSync } from 'node:fs';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString('utf8');
const title = prompt.match(/^## Task: (.+)$/m)?.[1];
const files = ${JSON.stringify(writes)}[title];
if (!files) throw new Error('Unexpected brief: ' + prompt);
mkdirSync('src', { recursive: true });
for (const [file, source] of Object.entries(files)) writeFileSync(file, source);
if (prompt.includes(${JSON.stringify(LOUD_TEST_GUIDANCE)})) writeFileSync(${JSON.stringify(NEW_TEST_FILE)}, ${JSON.stringify(loudTest)});
console.log('Implemented ' + title);
`;
}

/**
 * The final review fails until the fix task T002 exists. T002 lists the new test file
 * `NEW_TEST_FILE` and checks it, but the builder does not write it; the review seat, consulted on
 * the red check, tells the builder to write it.
 */
function missingTestPlannerScript(callsPath: string): string {
  const passing = passingVerdict({ kind: 'final', taskIds: [], criterionIds: [] });
  const fixT002 = {
    ...fix,
    suggestedFiles: ['src/alpha.mjs', NEW_TEST_FILE],
    checks: [{ id: 'T002-K1', kind: 'test', value: NEW_TEST_FILE, required: true }],
    findingIds: ['F1'],
  };
  return `import { appendFileSync } from 'node:fs';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString('utf8');
let kind;
let answer;
if (prompt.includes('# Choose the checks for this review')) {
  kind = 'review-checks';
  answer = null;
} else if (prompt.includes('# Final Implementation Review')) {
  kind = 'final-review';
  const ids = (label) => prompt.match(new RegExp('^' + label + ' (.+)$', 'm'))[1].split(',').map((id) => id.trim());
  const taskIds = ids('Task ids:');
  const fails = !taskIds.includes('T002');
  answer = {
    ...${JSON.stringify(passing)},
    tasks: taskIds.map((id) => ({ id, plan: fails ? 'partial' : 'met', note: '' })),
    criteria: ids('Criterion ids:').map((id) => ({ id, status: fails ? 'fail' : 'pass', evidence: '' })),
  };
  if (fails) {
    answer.findings = [${JSON.stringify(finding)}];
    answer.fixTasks = [${JSON.stringify(fixT002)}];
  }
} else if (/^# Consult on a failing task$/m.test(prompt)) {
  kind = 'consult';
  answer = {
    answer: {
      diagnosis: 'The builder never wrote the test file the check runs.',
      action: 'guidance',
      instructions: ${JSON.stringify(LOUD_TEST_GUIDANCE)},
      context: null,
    },
  };
} else if (prompt.includes('# Plan the change')) {
  kind = 'plan';
  answer = ${JSON.stringify({ result: plan })};
} else {
  throw new Error('Unexpected prompt: ' + prompt);
}
appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ kind, prompt }) + '\\n');
process.stdout.write(JSON.stringify(answer));
`;
}

async function startRun(planner: (callsPath: string) => string) {
  fixture = createStopContinueFixture(() => '', { isolation: 'none' });
  const target = fixture;
  restorePath = activateSafeCliShimPath(target.tmpDir);
  writeFileSync(
    join(target.projectDir, 'package.json'),
    `${JSON.stringify({ name: 'alpha', private: true, scripts: { test: 'node --test' } })}\n`,
  );
  git(target.projectDir, ['add', 'package.json']);
  git(target.projectDir, ['commit', '--quiet', '-m', 'add the project test script']);
  const callsPath = join(target.tmpDir, 'calls.jsonl');
  const plannerPath = join(target.tmpDir, 'planner.mjs');
  const implementerPath = join(target.tmpDir, 'implementer.mjs');
  const offlinePath = join(target.tmpDir, 'offline.mjs');
  writeFileSync(
    offlinePath,
    "globalThis.fetch = async () => { throw new Error('E2E network disabled'); };\n",
  );
  vi.stubEnv('NODE_OPTIONS', `--import=${offlinePath}`);
  writeFileSync(plannerPath, planner(callsPath));
  writeFileSync(implementerPath, implementerScript());
  const config = loadConfig(target.projectDir).config;
  if (config.planner.kind !== 'shell' || config.implementer.kind !== 'agent') {
    throw new Error('Expected local shell and agent fixture runners');
  }
  writeConfig(target.projectDir, {
    ...config,
    planner: { ...config.planner, args: [plannerPath] },
    implementer: { ...config.implementer, args: [implementerPath] },
    workflow: { ...config.workflow, approve: 'none' },
    validation: { ...config.validation, testCommand: undefined, endChecks: false },
  });

  const run = await cli(target, ['start', 'smoke'], { timeoutMs: 180_000 });
  const output = `${run.stdout}\n${run.stderr}`;
  const sessions = readdirSync(sessionsRoot(target.projectDir));
  expect(sessions, output).toHaveLength(1);
  const sessionId = sessions[0];
  if (sessionId === undefined) throw new Error('Missing session');
  const calls: Array<{ kind: string; prompt: string }> = readFileSync(callsPath, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const replay = await readRunEvents({ projectDir: target.projectDir, sessionId });
  expect(replay.diagnostics.skipped).toBe(0);
  const unrunnable = replay.events.filter(
    (event) => event.type === 'recovery_prompted' && event.reason === 'required-checks-unrunnable',
  );
  return { run, output, calls, state: readState(target, sessionId), unrunnable };
}

describe('e2e: a review fix task with a test check', { timeout: 300_000 }, () => {
  it('sends a test check that holds a command back to the reviewer, and runs the repaired check', async () => {
    const { run, output, calls, state, unrunnable } = await startRun(plannerScript);
    const repair = calls.find((call) => call.kind === 'final-review-repair');
    expect(repair?.prompt, output).toContain(refusedCheck);
    expect(state.tasks.find((task) => task.id === 'T002')?.checks).toMatchObject([
      { id: 'T002-K1', kind: 'test', value: TEST_FILE },
    ]);
    expect(unrunnable).toEqual([]);
    expect(state.phase).toBe('complete');
    expect(run.exitCode, output).toBe(0);
  });

  it.each([
    {
      name: 'a test path with a typo',
      check: { id: 'T002-K1', kind: 'test', value: 'src/alpha.tset.mjs', required: true },
      refusal:
        'Check T002-K1 is refused: a `test` check names one test file, and `src/alpha.tset.mjs` is no test file in the workspace, and no task lists it.',
    },
    {
      name: 'a test path with a trailing comma',
      check: { id: 'T002-K1', kind: 'test', value: `${TEST_FILE},`, required: true },
      refusal: `Check T002-K1 is refused: a \`test\` check names one test file, and \`${TEST_FILE},\` is no test file in the workspace, and no task lists it.`,
    },
    {
      name: 'a render id with a stray comma',
      check: { id: 'T002-K1', kind: 'render', value: 'workflow-x,', required: true },
      refusal:
        'Check T002-K1 is refused: a `render` check names one scenario id of lowercase letters, digits and hyphens, and `workflow-x,` is not one.',
    },
  ] satisfies Array<{ name: string; check: Check; refusal: string }>)(
    'sends $name back to the reviewer, and runs the repaired check',
    async ({ check, refusal }) => {
      const { run, output, calls, state, unrunnable } = await startRun((callsPath) =>
        plannerScript(callsPath, check),
      );
      const repair = calls.find((call) => call.kind === 'final-review-repair');
      expect(repair?.prompt, output).toContain(refusal);
      expect(state.tasks.find((task) => task.id === 'T002')?.checks).toMatchObject([
        { id: 'T002-K1', kind: 'test', value: TEST_FILE },
      ]);
      expect(unrunnable).toEqual([]);
      expect(state.phase).toBe('complete');
      expect(run.exitCode, output).toBe(0);
    },
  );

  it('fails the check on a new test file the builder did not write, and the builder writes it on the guided retry', async () => {
    const { run, output, calls, state, unrunnable } = await startRun(missingTestPlannerScript);
    expect(unrunnable, output).toEqual([]);
    const consults = calls.filter((call) => call.kind === 'consult');
    expect(consults, output).toHaveLength(1);
    expect(consults[0]?.prompt).toContain(
      `check T002-K1 did not pass (fail): the workspace has no test file for ${NEW_TEST_FILE}`,
    );
    expect(output.split('\n')).toContain('task T002: done (1 of 1 checks passed)');
    expect(state.tasks.map((task) => [task.id, task.status])).toEqual([
      ['T001', 'done'],
      ['T002', 'done'],
    ]);
    expect(state.phase, output).toBe('complete');
    expect(run.exitCode, output).toBe(0);
  });
});
