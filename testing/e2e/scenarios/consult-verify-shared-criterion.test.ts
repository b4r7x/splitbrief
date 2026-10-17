import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { sessionsRoot } from '../../../src/core/paths.js';
import type { ConsultAnswer } from '../../../src/core/schemas/consult.js';
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

const RUN_TIMEOUT_MS = 150_000;

const alpha = makeTaskSpec({
  id: 'T001',
  title: 'Add the alpha value',
  intent: 'Return the alpha value.',
  criteria: ['C1'],
  suggestedFiles: ['src/alpha.mjs', 'src/alpha.test.mjs'],
  checks: [{ id: 'T001-K1', kind: 'test', value: 'src/alpha.test.mjs', required: true }],
});
const beta = makeTaskSpec({
  id: 'T002',
  title: 'Add the beta value',
  intent: 'Return the beta value.',
  criteria: ['C1'],
  suggestedFiles: ['src/beta.mjs', 'src/beta.test.mjs'],
  checks: [{ id: 'T002-K1', kind: 'test', value: 'src/beta.test.mjs', required: true }],
});
const plan = makePlanProposal({
  summary: 'Add two tested values that serve one criterion.',
  decisions: [],
  criteria: [
    { id: 'C1', text: 'Alpha and beta are their strings.', checkIds: ['T001-K1', 'T002-K1'] },
  ],
  tasks: [alpha, beta],
});
const consult: ConsultAnswer = {
  answer: {
    diagnosis: 'The beta check failed on a service that was down; the files are right.',
    action: 'verify',
    checkIds: ['T001-K1', 'T002-K1'],
    reason: 'Both checks of C1 cover the files of the brief.',
  },
};
const ALPHA_FILES = {
  'src/alpha.mjs': "export const alpha = 'alpha';\n",
  'src/alpha.test.mjs':
    "import { strict as assert } from 'node:assert';\nimport { alpha } from './alpha.mjs';\nassert.equal(alpha, 'alpha');\n",
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

/**
 * The implementer writes correct files for both briefs, but T002's test also needs a service flag
 * that only the consult brings up, so its gate fails until the ladder consults. The planner answers
 * the consult with `verify` naming both checks of the shared criterion C1, one of them T001's.
 */
function writeRunners(target: StopContinueFixture, callsPath: string, servicePath: string) {
  const plannerPath = join(target.tmpDir, 'planner.mjs');
  const implementerPath = join(target.tmpDir, 'implementer.mjs');
  const passing = passingVerdict({
    kind: 'final',
    taskIds: [alpha.id, beta.id],
    criterionIds: ['C1'],
  });
  const betaTest = `import { strict as assert } from 'node:assert';
import { existsSync } from 'node:fs';
import { beta } from './beta.mjs';
assert.ok(existsSync(${JSON.stringify(servicePath)}), 'the beta service is down');
assert.equal(beta, 'beta');
`;
  writeFileSync(
    plannerPath,
    `import { appendFileSync, writeFileSync } from 'node:fs';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString('utf8');
let kind;
let answer;
if (prompt.includes('# Final Implementation Review') || prompt.includes('# Task Implementation Review')) {
  kind = prompt.includes('# Final Implementation Review') ? 'final-review' : 'task-review';
  const ids = (label) => {
    const match = prompt.match(new RegExp('^' + label + ' (.+)$', 'm'));
    if (!match) throw new Error('Missing required ids: ' + label);
    return match[1].split(',').map((id) => id.trim()).filter((id) => id !== '' && id !== 'none');
  };
  const passing = ${JSON.stringify(passing)};
  answer = {
    ...passing,
    tasks: ids('Task ids:').map((id) => passing.tasks.find((task) => task.id === id)),
    criteria: ids('Criterion ids:').map((id) => passing.criteria.find((criterion) => criterion.id === id)),
  };
} else if (prompt.includes('# Consult on a failing task') || prompt.includes('# Consult continued')) {
  kind = 'consult';
  writeFileSync(${JSON.stringify(servicePath)}, 'up\\n');
  answer = ${JSON.stringify(consult)};
} else if (prompt.includes('# Plan the change')) {
  kind = 'plan';
  answer = ${JSON.stringify({ result: plan })};
} else {
  throw new Error('Unexpected prompt: ' + prompt);
}
appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ kind }) + '\\n');
process.stdout.write(JSON.stringify(answer));
`,
  );
  writeFileSync(
    implementerPath,
    `import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString('utf8');
const title = prompt.match(/^## Task: (.+)$/m)?.[1];
const taskId = title === ${JSON.stringify(alpha.title)} ? 'T001' : title === ${JSON.stringify(beta.title)} ? 'T002' : undefined;
if (taskId === undefined) throw new Error('Unexpected brief: ' + prompt);
appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ kind: 'implement', taskId }) + '\\n');
const files = taskId === 'T001'
  ? ${JSON.stringify(ALPHA_FILES)}
  : { 'src/beta.mjs': "export const beta = 'beta';\\n", 'src/beta.test.mjs': ${JSON.stringify(betaTest)} };
mkdirSync('src', { recursive: true });
for (const [file, source] of Object.entries(files)) writeFileSync(file, source);
console.log('Implemented ' + taskId);
`,
  );
  const config = loadConfig(target.projectDir).config;
  if (config.planner.kind !== 'shell' || config.implementer.kind !== 'agent') {
    throw new Error('Expected local shell and agent fixture runners');
  }
  writeConfig(target.projectDir, {
    ...config,
    planner: { ...config.planner, args: [plannerPath] },
    implementer: { ...config.implementer, args: [implementerPath] },
    validation: { ...config.validation, testCommand: 'node --test' },
    workflow: { ...config.workflow, review: 'task', approve: 'none' },
  });
}

function readCalls(callsPath: string): string[] {
  return readFileSync(callsPath, 'utf8')
    .trim()
    .split('\n')
    .map((line) => {
      const call: { kind: string; taskId?: string } = JSON.parse(line);
      return call.taskId === undefined ? call.kind : `${call.kind} ${call.taskId}`;
    });
}

describe('e2e: consult verify on a shared criterion', { timeout: 240_000 }, () => {
  it("completes a brief as consulted when the verify names another task's check of its criterion", async () => {
    fixture = createStopContinueFixture(() => '', { isolation: 'none' });
    const target = fixture;
    restorePath = activateSafeCliShimPath(target.tmpDir);
    const offlinePath = join(target.tmpDir, 'offline.mjs');
    writeFileSync(
      offlinePath,
      "globalThis.fetch = async () => { throw new Error('E2E network disabled'); };\n",
    );
    vi.stubEnv('NODE_OPTIONS', `--import=${offlinePath}`);
    const callsPath = join(target.tmpDir, 'calls.jsonl');
    writeRunners(target, callsPath, join(target.tmpDir, 'beta-service.flag'));

    const run = await cli(target, ['start', 'smoke'], { timeoutMs: RUN_TIMEOUT_MS });

    expect(run.exitCode, `${run.stdout}\n${run.stderr}`).toBe(0);
    expect(readCalls(callsPath).filter((call) => call === 'consult')).toEqual(['consult']);
    const sessionId = readdirSync(sessionsRoot(target.projectDir))[0];
    if (sessionId === undefined) throw new Error('Missing session');
    const state = readState(target, sessionId);
    expect(state.phase).toBe('complete');
    expect(state.tasks.map((task) => ({ id: task.id, status: task.status }))).toEqual([
      { id: 'T001', status: 'done' },
      { id: 'T002', status: 'done' },
    ]);

    const { events } = await readRunEvents({ projectDir: target.projectDir, sessionId });
    expect(
      events.flatMap((event) =>
        event.type === 'consult_answered' ? [{ taskId: event.taskId, action: event.action }] : [],
      ),
    ).toEqual([{ taskId: 'T002', action: 'verify' }]);
    expect(
      events.find(
        (event) =>
          event.type === 'checks_run' && event.taskId === 'T002' && event.phase === 'implementing',
      ),
    ).toMatchObject({
      results: expect.arrayContaining([
        expect.objectContaining({ id: 'T001-K1', status: 'pass' }),
        expect.objectContaining({ id: 'T002-K1', status: 'pass' }),
      ]),
    });
    expect(
      events.flatMap((event) =>
        event.type === 'task_completed' ? [{ taskId: event.taskId, method: event.method }] : [],
      ),
    ).toEqual([
      { taskId: 'T001', method: 'local' },
      { taskId: 'T002', method: 'consulted' },
    ]);
    expect(events.find((event) => event.type === 'workflow_complete')).toMatchObject({
      review: 'passed',
    });
  });
});
