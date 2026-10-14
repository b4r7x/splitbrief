import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { fixCheckKeys } from '../../../src/core/review/fix-task.js';
import type { ReviewAnswer } from '../../../src/core/schemas/review.js';
import { readActive } from '../../../src/core/sessions/active-pointer.js';
import { deriveRunStatus } from '../../../src/core/sessions/run-status.js';
import { readRunEvents } from '../../../src/engine/events/replay.js';
import { activateSafeCliShimPath } from '#testing/helpers/compatible-cli-shim.js';
import { makePlanProposal, makeTaskSpec } from '#testing/helpers/factories/plan.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import {
  cli,
  createStopContinueFixture,
  readState,
  type StopContinueFixture,
} from '../helpers/stop-continue-fixture.js';

const CHECK_SCRIPT_FILE = 'tools/check.mjs';
const CHECK_COMMAND = `node ${CHECK_SCRIPT_FILE}`;
const LEGACY_SPEC_FILE = 'legacy/legacy.spec.mjs';
const SPEC_FILE = 'src/alpha.spec.mjs';
const OWN_KEY = `${SPEC_FILE}::main`;
const LEGACY_KEY = `${LEGACY_SPEC_FILE}::main`;
const LEGACY_MESSAGE = 'legacy behaviour is pending';

/**
 * The project's spec runner, committed before the run. It imports every `*.spec.mjs` and prints
 * one pytest-style row per spec that throws, so each failure has a stable key.
 */
const CHECK_SCRIPT = `import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

function specs(dir) {
  return readdirSync(dir === '' ? '.' : dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') return [];
    const path = dir === '' ? entry.name : dir + '/' + entry.name;
    if (entry.isDirectory()) return specs(path);
    return entry.name.endsWith('.spec.mjs') ? [path] : [];
  });
}

const failures = [];
for (const file of specs('').sort()) {
  try {
    await import(pathToFileURL(join(process.cwd(), file)).href);
  } catch (error) {
    failures.push('FAILED ' + file + '::main - ' + (error instanceof Error ? error.message : String(error)));
  }
}
for (const line of failures) console.log(line);
if (failures.length > 0) process.exitCode = 1;
else console.log('all specs passed');
`;

/** A spec that is red before the run starts, so the run base shows it too. */
const LEGACY_SPEC = `throw new Error(${JSON.stringify(LEGACY_MESSAGE)});\n`;

const ALPHA_BUGGY = "export const alpha = 'alpha';\nexport const loud = 'alpha';\n";
const ALPHA_FIXED = "export const alpha = 'alpha';\nexport const loud = 'ALPHA';\n";
const ALPHA_TEST =
  "import { strict as assert } from 'node:assert';\nimport { alpha } from './alpha.mjs';\nassert.equal(alpha, 'alpha');\n";
const ALPHA_SPEC =
  "import { strict as assert } from 'node:assert';\nimport { loud } from './alpha.mjs';\nassert.equal(loud, 'ALPHA', 'loud is the upper-case alpha');\n";
const BETA = "export const beta = 'beta';\n";
const BETA_TEST =
  "import { strict as assert } from 'node:assert';\nimport { beta } from './beta.mjs';\nassert.equal(beta, 'beta');\n";

const alpha = makeTaskSpec({
  id: 'T001',
  title: 'Add the alpha values',
  intent: 'Export alpha and its upper-case form loud.',
  criteria: ['C1'],
  suggestedFiles: ['src/alpha.mjs', 'src/alpha.test.mjs', SPEC_FILE],
  checks: [{ id: 'T001-K1', kind: 'test', value: 'src/alpha.test.mjs', required: true }],
});
const beta = makeTaskSpec({
  id: 'T002',
  title: 'Add the beta value',
  intent: 'Export the beta value.',
  criteria: ['C2'],
  suggestedFiles: ['src/beta.mjs', 'src/beta.test.mjs'],
  checks: [{ id: 'T002-K1', kind: 'test', value: 'src/beta.test.mjs', required: true }],
});
const fix = makeTaskSpec({
  id: 'T003',
  title: 'Make loud the upper-case alpha',
  intent: 'Export loud as the upper-case alpha value.',
  criteria: ['C1'],
  suggestedFiles: ['src/alpha.mjs'],
  contextFiles: [SPEC_FILE],
  checks: [{ id: 'T003-K1', kind: 'test', value: 'src/alpha.test.mjs', required: true }],
});
const plan = makePlanProposal({
  summary: 'Add the alpha and beta values.',
  decisions: [],
  criteria: [
    { id: 'C1', text: 'Alpha is alpha and loud is ALPHA.', checkIds: ['T001-K1'] },
    { id: 'C2', text: 'Beta is the string beta.', checkIds: ['T002-K1'] },
  ],
  tasks: [alpha, beta],
});
const finding: ReviewAnswer['findings'][number] = {
  id: 'F1',
  kind: 'defect',
  severity: 'blocking',
  taskId: alpha.id,
  criterionId: 'C1',
  file: SPEC_FILE,
  line: null,
  text: 'loud is not the upper-case alpha.',
  acceptance: 'The alpha spec passes.',
  checkIds: ['V1'],
};
const reviewChecks = {
  commands: [{ id: 'V1', command: CHECK_COMMAND, reason: 'The project runs its specs with it.' }],
  declined: [],
  reason: null,
};
/** One line of the review prompt's Pending Inputs section per red reviewer check input. */
const PENDING_INPUT = /^- \*\*(\S+)\*\* \(check · defect\)/gm;

type Call = {
  kind: string;
  taskId?: string;
  taskIds?: string[];
  inputs?: string[];
  required?: boolean;
  prompt?: string;
};

let fixture: StopContinueFixture | undefined;
let restorePath: (() => void) | undefined;

afterEach(() => {
  restorePath?.();
  vi.unstubAllEnvs();
  if (fixture !== undefined) cleanupTempDir(fixture.tmpDir);
  fixture = undefined;
  restorePath = undefined;
});

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: 'pipe' });
}

function plannerScript(callsPath: string): string {
  return `import { appendFileSync } from 'node:fs';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString('utf8');
const ids = (label) => {
  const match = prompt.match(new RegExp('^' + label + ' (.+)$', 'm'));
  if (!match) throw new Error('Missing required ids: ' + label);
  const value = match[1].trim();
  return value === 'none' ? [] : value.split(',').map((id) => id.trim());
};
const pendingInputs = () => {
  const heading = '## Pending Inputs';
  const from = prompt.indexOf(heading);
  if (from < 0) return [];
  const section = prompt.slice(from + heading.length).split(/^## /m)[0];
  return [...section.matchAll(new RegExp(${JSON.stringify(PENDING_INPUT.source)}, 'gm'))].map((match) => match[1]);
};
let call;
let answer;
if (prompt.includes('# Choose the checks for this review')) {
  call = { kind: 'checks', required: prompt.includes('## Commands a fix check ran') };
  answer = ${JSON.stringify(reviewChecks)};
} else if (prompt.includes('# Task Implementation Review') || prompt.includes('# Final Implementation Review')) {
  const kind = prompt.includes('# Task Implementation Review') ? 'task-review' : 'final-review';
  const taskIds = ids('Task ids:');
  const criterionIds = ids('Criterion ids:');
  const inputs = pendingInputs();
  const finding = ${JSON.stringify(finding)};
  answer = {
    tasks: taskIds.map((id) => ({ id, plan: 'met', note: '' })),
    criteria: criterionIds.map((id) => ({ id, status: 'pass', evidence: '' })),
    findings: [],
    fixTasks: [],
    rejected: [],
    verify: [],
    ask: null,
  };
  if (inputs.length > 0) {
    answer.tasks = answer.tasks.map((task) =>
      task.id === finding.taskId ? { ...task, plan: 'partial', note: finding.text } : task,
    );
    answer.criteria = answer.criteria.map((criterion) =>
      criterion.id === finding.criterionId
        ? { ...criterion, status: 'fail', evidence: finding.text }
        : criterion,
    );
    answer.findings = [finding];
    answer.fixTasks = [{ ...${JSON.stringify(fix)}, findingIds: [finding.id, ...inputs] }];
  }
  call = {
    kind: prompt.includes('It failed validation:') ? kind + '-repair' : kind,
    taskIds,
    inputs,
  };
} else if (prompt.includes('# Plan the change')) {
  call = { kind: 'plan' };
  answer = ${JSON.stringify({ result: plan })};
} else {
  throw new Error('Unexpected prompt: ' + prompt);
}
appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(call) + '\\n');
process.stdout.write(JSON.stringify(answer));
`;
}

function implementerScript(callsPath: string): string {
  const writes = [
    {
      task: alpha,
      files: {
        'src/alpha.mjs': ALPHA_BUGGY,
        'src/alpha.test.mjs': ALPHA_TEST,
        [SPEC_FILE]: ALPHA_SPEC,
      },
    },
    { task: beta, files: { 'src/beta.mjs': BETA, 'src/beta.test.mjs': BETA_TEST } },
    { task: fix, files: { 'src/alpha.mjs': ALPHA_FIXED } },
  ];
  return `import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString('utf8');
const title = prompt.match(/^## Task: (.+)$/m)?.[1];
const entry = ${JSON.stringify(writes)}.find((entry) => entry.task.title === title);
if (!entry) throw new Error('Unexpected brief: ' + prompt);
appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ kind: 'implement', taskId: entry.task.id, prompt }) + '\\n');
for (const [file, source] of Object.entries(entry.files)) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, source);
}
console.log('Implemented ' + entry.task.id);
`;
}

describe('e2e: failed task review creates fix tasks', { timeout: 300_000 }, () => {
  it('inserts a fix task carrying its failure keys, passes its gate on its own keys and applies the run', async () => {
    fixture = createStopContinueFixture(() => '', { isolation: 'worktree' });
    const target = fixture;
    mkdirSync(join(target.projectDir, 'legacy'), { recursive: true });
    writeFileSync(join(target.projectDir, CHECK_SCRIPT_FILE), CHECK_SCRIPT);
    writeFileSync(join(target.projectDir, LEGACY_SPEC_FILE), LEGACY_SPEC);
    git(target.projectDir, ['add', CHECK_SCRIPT_FILE, LEGACY_SPEC_FILE]);
    git(target.projectDir, ['commit', '--quiet', '-m', 'add the spec runner']);
    restorePath = activateSafeCliShimPath(target.tmpDir);
    const callsPath = join(target.tmpDir, 'calls.jsonl');
    const plannerPath = join(target.tmpDir, 'planner.mjs');
    const implementerPath = join(target.tmpDir, 'implementer.mjs');
    const offlinePath = join(target.tmpDir, 'offline.mjs');
    writeFileSync(
      offlinePath,
      "globalThis.fetch = async () => { throw new Error('E2E network disabled'); };\n",
    );
    vi.stubEnv('NODE_OPTIONS', `--import=${offlinePath}`);
    writeFileSync(plannerPath, plannerScript(callsPath));
    writeFileSync(implementerPath, implementerScript(callsPath));

    const config = loadConfig(target.projectDir).config;
    if (config.planner.kind !== 'shell' || config.implementer.kind !== 'agent') {
      throw new Error('Expected local shell and agent fixture runners');
    }
    writeConfig(target.projectDir, {
      ...config,
      planner: { ...config.planner, args: [plannerPath] },
      implementer: { ...config.implementer, args: [implementerPath] },
      workflow: { ...config.workflow, review: 'task', approve: 'none' },
      validation: {
        ...config.validation,
        endChecks: true,
        approveChecks: 'auto',
        testCommand: 'node --test',
      },
    });

    const run = await cli(target, ['start', 'smoke'], { timeoutMs: 180_000 });
    expect(run.exitCode, `${run.stdout}\n${run.stderr}`).toBe(0);
    const sessionId = readActive(target.projectDir);
    if (sessionId === null) throw new Error(`the run left no active session: ${run.stderr}`);

    const ready = readState(target, sessionId);
    expect(deriveRunStatus({ state: ready, liveness: 'not-alive' }).kind).toBe('ready-to-apply');
    expect(ready.workspace?.kind).toBe('worktree');
    expect(existsSync(join(target.projectDir, 'src/alpha.mjs'))).toBe(false);

    const calls: Call[] = readFileSync(callsPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(calls.map((call) => call.kind)).toEqual([
      'plan',
      'implement',
      'checks',
      'task-review',
      'implement',
      'checks',
      'task-review',
      'implement',
      'checks',
      'task-review',
      'checks',
      'final-review',
    ]);
    expect(calls.filter((call) => call.kind === 'implement').map((call) => call.taskId)).toEqual([
      'T001',
      'T003',
      'T002',
    ]);
    expect(calls.filter((call) => call.kind === 'checks').map((call) => call.required)).toEqual([
      false,
      true,
      false,
      false,
    ]);
    const reviews = calls.filter((call) => call.kind.endsWith('review'));
    expect(reviews[0]).toMatchObject({ taskIds: ['T001'], inputs: ['V1.1'] });
    expect(reviews.slice(1).map((call) => call.inputs)).toEqual([[], [], []]);
    const fixBrief = calls.find((call) => call.kind === 'implement' && call.taskId === 'T003');
    expect(fixBrief?.prompt).toContain(`Command V1: ${CHECK_COMMAND}`);
    expect(fixBrief?.prompt).toContain('**V1.1**');

    expect(ready.tasks.map((task) => task.id)).toEqual(['T001', 'T003', 'T002']);
    expect(ready.tasks.every((task) => task.status === 'done')).toBe(true);
    expect(ready.tasks.filter((task) => task.fix !== undefined).map((task) => task.id)).toEqual([
      'T003',
    ]);
    const fixTask = ready.tasks.find((task) => task.id === 'T003');
    if (fixTask === undefined) throw new Error('the fix task is missing');
    const carried = {
      file: SPEC_FILE,
      checkIds: ['V1'],
      commands: { V1: CHECK_COMMAND },
      failureKeys: { V1: [OWN_KEY] },
      redKeys: { V1: [LEGACY_KEY, OWN_KEY] },
    };
    expect(fixTask.fix).toMatchObject({
      cycle: 1,
      findings: [
        { id: 'F1', ...carried },
        { id: 'V1.1', ...carried },
      ],
    });
    expect(fixCheckKeys(fixTask).get('V1')).toEqual({
      failureKeys: [OWN_KEY],
      redKeys: [LEGACY_KEY, OWN_KEY],
    });
    expect(fixTask.checkResults).toContainEqual({ id: 'V1', status: 'pass' });
    expect(ready.triage).toMatchObject([
      {
        cycle: 1,
        inputIds: ['F1', 'V1.1'],
        result: { fixTasks: [{ id: 'T003', findingIds: ['F1', 'V1.1'] }], rejected: [] },
      },
    ]);
    expect(ready.pendingReviewCommands).toBeUndefined();

    const replay = await readRunEvents({ projectDir: target.projectDir, sessionId });
    expect(replay.diagnostics.skipped).toBe(0);
    const events = replay.events;
    expect(
      events.filter((event) => event.type === 'task_started').map((event) => event.taskId),
    ).toEqual(['T001', 'T003', 'T002']);
    expect(events.filter((event) => event.type === 'review_fix_started')).toMatchObject([
      { cycle: 1, taskIds: ['T003'] },
    ]);
    expect(
      events.flatMap((event) =>
        event.type === 'review_completed'
          ? [{ scope: event.scope, afterTaskId: event.afterTaskId, verdict: event.verdict }]
          : [],
      ),
    ).toEqual([
      { scope: 'task', afterTaskId: 'T001', verdict: 'fail' },
      { scope: 'task', afterTaskId: 'T003', verdict: 'pass' },
      { scope: 'task', afterTaskId: 'T002', verdict: 'pass' },
      { scope: 'final', afterTaskId: undefined, verdict: 'pass' },
    ]);
    expect(
      events.find((event) => event.type === 'review_completed' && event.afterTaskId === 'T001'),
    ).toMatchObject({ findings: { blocking: 2, minor: 0 } });

    const reviewCheckRows = events.flatMap((event) =>
      event.type === 'full_suite' && event.status === 'done' && event.id === 'V1'
        ? [
            {
              moment: event.moment,
              passed: event.passed,
              newFailures: event.newFailures,
              preExisting: event.preExisting,
              own: event.own,
              ownLeft: event.ownLeft,
              others: event.others,
              proven: event.proven,
            },
          ]
        : [],
    );
    const laterReview = [
      { moment: 'pre-review', passed: false },
      { moment: 'base', passed: false, newFailures: 0, preExisting: 1 },
    ];
    expect(reviewCheckRows).toMatchObject([
      { moment: 'pre-review', passed: false },
      { moment: 'base', passed: false, newFailures: 1, preExisting: 1 },
      { moment: 'brief', passed: true, own: 1, ownLeft: 0, others: 1, proven: true },
      ...laterReview,
      ...laterReview,
      ...laterReview,
    ]);

    const fixGate = events.find((event) => event.type === 'checks_run' && event.taskId === 'T003');
    expect(fixGate).toMatchObject({
      results: [
        { id: 'T003-K1', status: 'pass' },
        { id: 'T001-K1', status: 'pass' },
        { id: 'V1', status: 'pass' },
      ],
    });

    const applied = await cli(target, ['continue', sessionId, '--action', 'apply'], {
      timeoutMs: 120_000,
    });
    expect(applied.exitCode, `${applied.stdout}\n${applied.stderr}`).toBe(0);
    const closed = readState(target, sessionId);
    expect(closed.closed?.as).toBe('applied');
    expect(deriveRunStatus({ state: closed, liveness: 'not-alive' }).kind).toBe('closed');
    if (ready.workspace !== undefined) expect(existsSync(ready.workspace.path)).toBe(false);
    expect(readFileSync(join(target.projectDir, 'src/alpha.mjs'), 'utf8')).toBe(ALPHA_FIXED);
    expect(readFileSync(join(target.projectDir, SPEC_FILE), 'utf8')).toBe(ALPHA_SPEC);
    expect(readFileSync(join(target.projectDir, 'src/beta.mjs'), 'utf8')).toBe(BETA);
    expect(readFileSync(join(target.projectDir, LEGACY_SPEC_FILE), 'utf8')).toBe(LEGACY_SPEC);
    const specs = spawnSync(process.execPath, [CHECK_SCRIPT_FILE], {
      cwd: target.projectDir,
      encoding: 'utf8',
    });
    expect(specs.status).toBe(1);
    expect(specs.stdout).toBe(`FAILED ${LEGACY_KEY} - ${LEGACY_MESSAGE}\n`);
  });
});
