import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { sessionsRoot } from '../../../src/core/paths.js';
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
const DIAGNOSIS = 'The brief does not say which value alpha must hold.';
const REFUSED =
  'Check T001-K2 is refused: `grep -F alpha src/alpha.mjs` runs a program outside the allowlist (grep).';

const alpha = makeTaskSpec({
  id: 'T001',
  title: 'Add the alpha value',
  intent: 'Return the alpha value.',
  criteria: ['C1'],
  suggestedFiles: ['src/alpha.mjs', 'src/alpha.test.mjs'],
  checks: [{ id: 'T001-K1', kind: 'test', value: 'src/alpha.test.mjs', required: true }],
});
const rewritten = {
  ...alpha,
  title: 'Export the alpha string',
  intent: 'Export the string alpha.',
};
const refusedRewrite = {
  ...rewritten,
  checks: [
    ...rewritten.checks,
    { id: 'T001-K2', kind: 'cmd', value: 'grep -F alpha src/alpha.mjs', required: true },
  ],
};
const plan = makePlanProposal({
  summary: 'Add a tested alpha value.',
  decisions: [],
  criteria: [{ id: 'C1', text: 'Alpha is the string alpha.', checkIds: ['T001-K1'] }],
  tasks: [alpha],
});
const ALPHA_TEST =
  "import { strict as assert } from 'node:assert';\nimport { alpha } from './alpha.mjs';\nassert.equal(alpha, 'alpha');\n";

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
 * The planner answers T001's consult with a rewrite that adds a `grep` check, and its repair with
 * the same rewrite without it. The implementer writes a value the test rejects until its brief is
 * the rewritten one.
 */
function writeRunners(target: StopContinueFixture, callsPath: string) {
  const plannerPath = join(target.tmpDir, 'planner.mjs');
  const implementerPath = join(target.tmpDir, 'implementer.mjs');
  const passing = passingVerdict({ kind: 'final', taskIds: [alpha.id], criterionIds: ['C1'] });
  writeFileSync(
    plannerPath,
    `import { appendFileSync } from 'node:fs';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString('utf8');
let kind;
let answer;
if (prompt.includes('# Final Implementation Review') || prompt.includes('# Task Implementation Review')) {
  kind = prompt.includes('# Final Implementation Review') ? 'final-review' : 'task-review';
  answer = ${JSON.stringify(passing)};
} else if (prompt.includes('# Consult on a failing task') || prompt.includes('# Consult continued')) {
  const repair = prompt.includes('It failed validation:');
  kind = repair ? 'consult-repair' : 'consult';
  answer = {
    answer: {
      diagnosis: ${JSON.stringify(DIAGNOSIS)},
      action: 'rewrite-task',
      task: repair ? ${JSON.stringify(rewritten)} : ${JSON.stringify(refusedRewrite)},
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
`,
  );
  writeFileSync(
    implementerPath,
    `import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString('utf8');
const title = prompt.match(/^## Task: (.+)$/m)?.[1];
appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ kind: 'implement', title, prompt }) + '\\n');
mkdirSync('src', { recursive: true });
const value = title === ${JSON.stringify(rewritten.title)} ? 'alpha' : 'not alpha';
writeFileSync('src/alpha.mjs', 'export const alpha = ' + JSON.stringify(value) + ';\\n');
writeFileSync('src/alpha.test.mjs', ${JSON.stringify(ALPHA_TEST)});
console.log('Implemented T001');
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

describe('e2e: consult rewrite with a refused check', { timeout: 240_000 }, () => {
  it('sends a rewrite with a refused check back to PLAN and finishes the run on the repaired brief', async () => {
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
    writeRunners(target, callsPath);

    const run = await cli(target, ['start', 'smoke'], { timeoutMs: RUN_TIMEOUT_MS });
    expect(run.exitCode, `${run.stdout}\n${run.stderr}`).toBe(0);

    const calls: { kind: string; title?: string; prompt: string }[] = readFileSync(
      callsPath,
      'utf8',
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(
      calls.filter((call) => call.kind.startsWith('consult')).map((call) => call.kind),
    ).toEqual(['consult', 'consult-repair']);
    expect(calls.find((call) => call.kind === 'consult-repair')?.prompt).toContain(REFUSED);
    expect(calls.filter((call) => call.kind === 'implement').at(-1)?.title).toBe(rewritten.title);

    const sessionId = readdirSync(sessionsRoot(target.projectDir))[0];
    if (sessionId === undefined) throw new Error('Missing session');
    const state = readState(target, sessionId);
    expect(state.phase).toBe('complete');
    expect(
      state.tasks.map((task) => ({ id: task.id, title: task.title, status: task.status })),
    ).toEqual([{ id: 'T001', title: rewritten.title, status: 'done' }]);
    // The refused command never becomes a required check of the brief.
    expect(JSON.stringify(state.tasks)).not.toContain('grep');

    const { events } = await readRunEvents({ projectDir: target.projectDir, sessionId });
    expect(events.find((event) => event.type === 'consult_answered')).toMatchObject({
      taskId: 'T001',
      action: 'rewrite-task',
      diagnosis: DIAGNOSIS,
    });
    expect(events.find((event) => event.type === 'workflow_complete')).toMatchObject({
      review: 'passed',
    });
  });
});
