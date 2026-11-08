import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { sessionsRoot } from '../../../src/core/paths.js';
import type { ConsultAnswer } from '../../../src/core/schemas/consult.js';
import { readRunEvents } from '../../../src/engine/events/replay.js';
import { resetWorkflow } from '../../../src/stores/workflow/actions/reset.js';
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
import { transcriptText } from '../helpers/transcript-text.js';

const RUN_TIMEOUT_MS = 150_000;

const alpha = makeTaskSpec({
  id: 'T001',
  title: 'Add the alpha value',
  intent: 'Return the alpha value.',
  criteria: ['C1'],
  suggestedFiles: ['src/alpha.mjs', 'src/alpha.test.mjs'],
  checks: [{ id: 'T001-K1', kind: 'test', value: 'src/alpha.test.mjs' }],
});
const beta = makeTaskSpec({
  id: 'T002',
  title: 'Add the beta value',
  intent: 'Return the beta value.',
  criteria: ['C1'],
  suggestedFiles: ['src/beta.mjs', 'src/beta.test.mjs'],
  checks: [{ id: 'T002-K1', kind: 'test', value: 'src/beta.test.mjs' }],
});
const plan = makePlanProposal({
  summary: 'Add two tested values that serve one criterion.',
  decisions: [],
  criteria: [
    { id: 'C1', text: 'Alpha and beta are their strings.', checkIds: ['T001-K1', 'T002-K1'] },
  ],
  tasks: [alpha, beta],
});
const verify = (checkIds: string[]): ConsultAnswer => ({
  answer: {
    diagnosis: 'The beta check failed on a service that was down; the files are right.',
    action: 'verify',
    checkIds,
    reason: 'The checks cover the files of the brief.',
  },
});
// The first answer misses T001-K1, the other check of the due criterion C1.
const REFUSED = verify(['T002-K1']);
const REPAIRED = verify(['T001-K1', 'T002-K1']);
const ALPHA_FILES = {
  'src/alpha.mjs': "export const alpha = 'alpha';\n",
  'src/alpha.test.mjs':
    "import { strict as assert } from 'node:assert';\nimport { alpha } from './alpha.mjs';\nassert.equal(alpha, 'alpha');\n",
};

let fixture: StopContinueFixture | undefined;
let restorePath: (() => void) | undefined;

afterEach(() => {
  resetWorkflow();
  restorePath?.();
  vi.unstubAllEnvs();
  if (fixture !== undefined) cleanupTempDir(fixture.tmpDir);
  fixture = undefined;
  restorePath = undefined;
});

/**
 * T002's test needs a service flag that only the consult brings up, so its gate fails until the
 * ladder consults. The planner's first consult answer is a `verify` that misses T001-K1; every
 * later consult call, the repair or a new consult, names both checks of C1.
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
    `import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString('utf8');
const calls = existsSync(${JSON.stringify(callsPath)}) ? readFileSync(${JSON.stringify(callsPath)}, 'utf8') : '';
const consults = calls.split('\\n').filter((line) => line.includes('"consult')).length;
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
} else if (
  prompt.includes('# Consult on a failing task') ||
  prompt.includes('# Consult continued') ||
  (consults > 0 && prompt.includes('Your previous answer failed validation:'))
) {
  kind = prompt.includes('failed validation') ? 'consult-repair' : 'consult';
  writeFileSync(${JSON.stringify(servicePath)}, 'up\\n');
  answer = consults === 0 ? ${JSON.stringify(REFUSED)} : ${JSON.stringify(REPAIRED)};
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
    .map((line) => (JSON.parse(line) as { kind: string }).kind);
}

describe('e2e: a consult verify selection that misses a due check', { timeout: 240_000 }, () => {
  it('asks the planner again for the selection and shows one verify row, the one that ran', async () => {
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

    const output = `${run.stdout}\n${run.stderr}`;
    expect(run.exitCode, output).toBe(0);
    expect(readCalls(callsPath).filter((kind) => kind.startsWith('consult'))).toEqual([
      'consult',
      'consult-repair',
    ]);
    const sessionId = readdirSync(sessionsRoot(target.projectDir))[0];
    if (sessionId === undefined) throw new Error('Missing session');
    const state = readState(target, sessionId);
    expect(state.phase).toBe('complete');
    expect(state.lineages?.T002?.consultRecords.map((record) => record.answer.answer)).toEqual([
      REPAIRED.answer,
    ]);

    const { events } = await readRunEvents({ projectDir: target.projectDir, sessionId });
    expect(
      events.flatMap((event) =>
        event.type === 'consult_answered'
          ? [{ taskId: event.taskId, action: event.action, checkIds: event.checkIds }]
          : [],
      ),
    ).toEqual([{ taskId: 'T002', action: 'verify', checkIds: ['T001-K1', 'T002-K1'] }]);
    expect(
      events.flatMap((event) =>
        event.type === 'task_completed' ? [{ taskId: event.taskId, method: event.method }] : [],
      ),
    ).toEqual([
      { taskId: 'T001', method: 'local' },
      { taskId: 'T002', method: 'consulted' },
    ]);
    const transcript = transcriptText(events);
    const verifyRows = transcript.split('\n').filter((line) => /\bverify T00\d/.test(line));
    expect(verifyRows, transcript).toHaveLength(1);
    expect(verifyRows[0]).toContain('verify T001-K1, T002-K1');
    expect(transcript).not.toContain('did not match its contract');
  });
});
