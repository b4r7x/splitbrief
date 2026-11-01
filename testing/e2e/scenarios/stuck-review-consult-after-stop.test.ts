import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { readActive } from '../../../src/core/sessions/active-pointer.js';
import { deriveRunStatus } from '../../../src/core/sessions/run-status.js';
import { activateSafeCliShimPath } from '#testing/helpers/compatible-cli-shim.js';
import { makePlanProposal, makeTaskSpec } from '#testing/helpers/factories/plan.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import {
  cli,
  createStopContinueFixture,
  readState,
  type StopContinueFixture,
} from '../helpers/stop-continue-fixture.js';

const RUN_TIMEOUT_MS = 150_000;
const HOLD_WAIT_MS = 75_000;
const TOTAL_FILE = 'src/total.mjs';
const TOTAL_TEST_FILE = 'src/total.test.mjs';
const TOTAL_SOURCE = 'export const total = (a, b) => a + b;\n';
const TOTAL_TEST_SOURCE = `import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { total } from './total.mjs';

test('total adds two numbers', () => {
  assert.equal(total(1, 2), 3);
});
`;
const FAILED = 'total("1", "2") returns "12".';
const DIAGNOSIS = 'The repair brief never converts the operands.';
const REWRITTEN = 'Convert the operands in total';

const brief = makeTaskSpec({
  id: 'T001',
  title: 'Add the total helper',
  intent: 'Return the sum of two numbers.',
  criteria: ['C1'],
  suggestedFiles: [TOTAL_FILE, TOTAL_TEST_FILE],
  checks: [{ id: 'T001-K1', kind: 'test', value: TOTAL_TEST_FILE, required: true }],
});
const repair = makeTaskSpec({
  id: 'T002',
  title: 'Repair total',
  intent: 'Make total add numeric strings.',
  criteria: ['C1'],
  suggestedFiles: [TOTAL_FILE],
  checks: [{ id: 'T002-K1', kind: 'test', value: TOTAL_TEST_FILE, required: true }],
});
const plan = makePlanProposal({
  summary: 'Add a total helper with its test.',
  decisions: [],
  criteria: [{ id: 'C1', text: 'total returns the sum.', checkIds: ['T001-K1'] }],
  tasks: [brief],
});
const finding = {
  id: 'F1',
  kind: 'defect',
  severity: 'blocking',
  taskId: brief.id,
  criterionId: 'C1',
  file: TOTAL_FILE,
  line: null,
  text: FAILED,
  acceptance: null,
  checkIds: null,
};

type Call = { kind: string; title?: string; prompt?: string };

let fixture: StopContinueFixture | undefined;
let restorePath: (() => void) | undefined;

afterEach(() => {
  restorePath?.();
  vi.unstubAllEnvs();
  if (fixture !== undefined) {
    writeFileSync(join(fixture.tmpDir, 'release'), '');
    cleanupTempDir(fixture.tmpDir);
  }
  fixture = undefined;
  restorePath = undefined;
});

function readCalls(path: string): Call[] {
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}

/**
 * The first two final reviews fail on F1, so the second is stuck and asks the planner. The first
 * consult holds until the run is stopped. The consult after continue rewrites the stuck fix
 * brief; the review after that passes.
 */
function plannerScript(tmpDir: string, callsPath: string): string {
  return `import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString('utf8');
const count = (kind) =>
  existsSync(${JSON.stringify(callsPath)})
    ? readFileSync(${JSON.stringify(callsPath)}, 'utf8')
        .split('\\n')
        .filter((line) => line !== '' && JSON.parse(line).kind === kind).length
    : 0;
const ids = (label) => {
  const value = prompt.match(new RegExp('^' + label + ' (.+)$', 'm'))?.[1].trim();
  if (value === undefined) throw new Error('Missing ids: ' + label);
  return value === 'none' ? [] : value.split(',').map((id) => id.trim());
};
let call;
let answer;
if (prompt.includes('# Final Implementation Review')) {
  call = { kind: 'final-review', prompt };
  answer = {
    tasks: ids('Task ids:').map((id) => ({ id, plan: 'met', note: '' })),
    criteria: ids('Criterion ids:').map((id) => ({ id, status: 'pass', evidence: '' })),
    findings: [],
    fixTasks: [],
    rejected: [],
    ask: null,
  };
  if (count('final-review') < 2) {
    const finding = ${JSON.stringify(finding)};
    answer.criteria = answer.criteria.map((criterion) =>
      criterion.id === finding.criterionId ? { ...criterion, status: 'fail', evidence: finding.text } : criterion,
    );
    answer.findings = [finding];
    answer.fixTasks = [{ ...${JSON.stringify(repair)}, findingIds: [finding.id] }];
  }
} else if (/^# Consult/m.test(prompt)) {
  call = { kind: 'consult', prompt };
  if (count('consult') === 0) {
    appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(call) + '\\n');
    writeFileSync(${JSON.stringify(join(tmpDir, 'consult-holding'))}, String(process.pid));
    const deadline = Date.now() + 180000;
    while (!existsSync(${JSON.stringify(join(tmpDir, 'release'))}) && Date.now() < deadline) await delay(50);
    process.exit(1);
  }
  const target = prompt.match(/^## Task (T\\d{3})/m)?.[1];
  answer = {
    answer: {
      diagnosis: ${JSON.stringify(DIAGNOSIS)},
      action: 'rewrite-task',
      task: { ...${JSON.stringify(repair)}, id: target, title: ${JSON.stringify(REWRITTEN)} },
    },
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

/** Each brief writes a new line, so no fix brief ends without a change. */
function implementerScript(callsPath: string): string {
  return `import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString('utf8');
const title = prompt.match(/^## Task: (.+)$/m)?.[1];
const builds = readFileSync(${JSON.stringify(callsPath)}, 'utf8').split('\\n').filter((line) => line !== '' && JSON.parse(line).kind === 'implement').length;
const files = {
  ${JSON.stringify(brief.title)}: { ${JSON.stringify(TOTAL_FILE)}: ${JSON.stringify(TOTAL_SOURCE)}, ${JSON.stringify(TOTAL_TEST_FILE)}: ${JSON.stringify(TOTAL_TEST_SOURCE)} },
  ${JSON.stringify(repair.title)}: { ${JSON.stringify(TOTAL_FILE)}: ${JSON.stringify(TOTAL_SOURCE)} + '// repair ' + builds + '\\n' },
  ${JSON.stringify(REWRITTEN)}: { ${JSON.stringify(TOTAL_FILE)}: 'export const total = (a, b) => Number(a) + Number(b);\\n' },
}[title];
if (!files) throw new Error('Unexpected brief: ' + prompt);
appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ kind: 'implement', title }) + '\\n');
mkdirSync('src', { recursive: true });
for (const [file, source] of Object.entries(files)) writeFileSync(file, source);
console.log('Implemented ' + title);
`;
}

describe('e2e: continue after a stop in the stuck-review planner call', {
  timeout: 300_000,
}, () => {
  it('asks the planner again on continue and builds its rewritten fix brief before the next review', async () => {
    fixture = createStopContinueFixture(() => '');
    const target = fixture;
    restorePath = activateSafeCliShimPath(target.tmpDir);
    const callsPath = join(target.tmpDir, 'calls.jsonl');
    writeFileSync(callsPath, '');
    const plannerPath = join(target.tmpDir, 'planner.mjs');
    const implementerPath = join(target.tmpDir, 'implementer.mjs');
    const offlinePath = join(target.tmpDir, 'offline.mjs');
    writeFileSync(
      offlinePath,
      "globalThis.fetch = async () => { throw new Error('E2E network disabled'); };\n",
    );
    vi.stubEnv('NODE_OPTIONS', `--import=${offlinePath}`);
    writeFileSync(plannerPath, plannerScript(target.tmpDir, callsPath));
    writeFileSync(implementerPath, implementerScript(callsPath));
    const config = loadConfig(target.projectDir).config;
    if (config.planner.kind !== 'shell' || config.implementer.kind !== 'agent') {
      throw new Error('Expected local shell and agent fixture runners');
    }
    writeConfig(target.projectDir, {
      ...config,
      planner: { ...config.planner, args: [plannerPath] },
      implementer: { ...config.implementer, args: [implementerPath] },
      workflow: { ...config.workflow, approve: 'none' },
      validation: { ...config.validation, endChecks: false, testCommand: 'node --test' },
    });

    let groupPid: number | undefined;
    const run = cli(target, ['start', 'total'], {
      timeoutMs: RUN_TIMEOUT_MS,
      onSpawn: (pid) => {
        groupPid = pid;
      },
    });
    const holding = join(target.tmpDir, 'consult-holding');
    const deadline = Date.now() + HOLD_WAIT_MS;
    while (!existsSync(holding) && Date.now() < deadline) await delay(100);
    if (!existsSync(holding)) throw new Error(`the consult never held: ${(await run).stderr}`);
    if (groupPid === undefined) throw new Error('the CLI reported no pid to signal');
    process.kill(-groupPid, 'SIGINT');
    await run;
    const sessionId = readActive(target.projectDir);
    if (sessionId === null) throw new Error('the stopped run saved no session');
    const stopped = readState(target, sessionId);
    expect(stopped.pendingTriage?.plannerConsult).toBe(true);
    expect(stopped.pendingRecovery).toBeUndefined();

    const continued = await cli(target, ['continue', sessionId], { timeoutMs: RUN_TIMEOUT_MS });
    expect(continued.exitCode, `${continued.stdout}\n${continued.stderr}`).toBe(0);

    const calls = readCalls(callsPath);
    expect(calls.map((call) => call.title ?? call.kind)).toEqual([
      'plan',
      brief.title,
      'final-review',
      repair.title,
      'final-review',
      'consult',
      'consult',
      REWRITTEN,
      'final-review',
    ]);
    expect(calls[6]?.prompt).toContain(`F1: ${FAILED}`);
    const ready = readState(target, sessionId);
    expect(ready.reviewStatus).toBe('passed');
    expect(ready.tasks.find((task) => task.title === REWRITTEN)).toMatchObject({ status: 'done' });
    expect(deriveRunStatus({ state: ready, liveness: 'not-alive' }).kind).toBe('ready-to-apply');
    const lines = continued.stdout.split('\n');
    const stuck = lines.indexOf(
      `review: stuck after T002 · planner: new fix brief T003 · ${DIAGNOSIS}`,
    );
    expect(stuck, continued.stdout).toBeGreaterThanOrEqual(0);
    expect(lines.slice(stuck)).toEqual(
      expect.arrayContaining(['task T003: done (1 of 1 checks passed)', 'review: passed']),
    );
  });
});
