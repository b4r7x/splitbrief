import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { sessionsRoot } from '../../../src/core/paths.js';
import { activateSafeCliShimPath } from '#testing/helpers/compatible-cli-shim.js';
import { makePlanProposal, makeTaskSpec } from '#testing/helpers/factories/plan.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { passingVerdict } from '#testing/helpers/typed-planner.js';
import {
  cli,
  createStopContinueFixture,
  readState,
  type StopContinueFixture,
} from '../helpers/stop-continue-fixture.js';

const alpha = makeTaskSpec({
  id: 'T001',
  title: 'Add the alpha value',
  intent: 'Return the alpha value.',
  criteria: ['C1'],
  suggestedFiles: ['src/alpha.mjs', 'src/alpha.test.mjs'],
  checks: [{ id: 'T001-K1', kind: 'test', value: 'src/alpha.test.mjs', required: true }],
});
const plan = makePlanProposal({
  summary: 'Add one tested value.',
  decisions: [],
  criteria: [{ id: 'C1', text: 'Alpha is the string alpha.', checkIds: ['T001-K1'] }],
  tasks: [alpha],
});
const ALPHA_FILES = {
  'src/alpha.mjs': "export const alpha = 'alpha';\n",
  'src/alpha.test.mjs':
    "import { strict as assert } from 'node:assert';\nimport { alpha } from './alpha.mjs';\nassert.equal(alpha, 'alpha');\n",
};
const kept = { what: 'Kept alpha in one module', why: 'The test imports it from there.' };

let fixture: StopContinueFixture | undefined;
let restorePath: (() => void) | undefined;

beforeEach(() => resetAllStores());

afterEach(() => {
  resetAllStores();
  restorePath?.();
  vi.unstubAllEnvs();
  if (fixture !== undefined) cleanupTempDir(fixture.tmpDir);
  fixture = undefined;
  restorePath = undefined;
});

/** A run whose one attempt reports `kept`; the planner fails the run on any consult. */
async function runDeclaredDecision() {
  fixture = createStopContinueFixture(() => '', { isolation: 'none' });
  const target = fixture;
  restorePath = activateSafeCliShimPath(target.tmpDir);
  const offlinePath = join(target.tmpDir, 'offline.mjs');
  writeFileSync(
    offlinePath,
    "globalThis.fetch = async () => { throw new Error('E2E network disabled'); };\n",
  );
  vi.stubEnv('NODE_OPTIONS', `--import=${offlinePath}`);
  const reviewPath = join(target.tmpDir, 'review.md');
  const attemptsPath = join(target.tmpDir, 'attempts');
  const plannerPath = join(target.tmpDir, 'planner.mjs');
  const implementerPath = join(target.tmpDir, 'implementer.mjs');
  const passing = passingVerdict({ kind: 'final', taskIds: [alpha.id], criterionIds: ['C1'] });
  writeFileSync(
    plannerPath,
    `import { writeFileSync } from 'node:fs';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString('utf8');
let answer;
if (prompt.includes('# Final Implementation Review')) {
  writeFileSync(${JSON.stringify(reviewPath)}, prompt);
  answer = ${JSON.stringify(passing)};
} else if (prompt.includes('# Task Implementation Review')) {
  answer = ${JSON.stringify(passing)};
} else if (prompt.includes('# Plan the change')) {
  answer = ${JSON.stringify({ result: plan })};
} else {
  throw new Error('Unexpected prompt: ' + prompt);
}
process.stdout.write(JSON.stringify(answer));
`,
  );
  writeFileSync(
    implementerPath,
    `import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
for await (const _chunk of process.stdin);
appendFileSync(${JSON.stringify(attemptsPath)}, 'x');
for (const [file, source] of Object.entries(${JSON.stringify(ALPHA_FILES)})) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, source);
}
console.log('Implemented T001');
console.log(JSON.stringify({
  status: 'done',
  filesChanged: ${JSON.stringify(Object.keys(ALPHA_FILES))},
  touchedNotSuggested: [],
  notes: null,
  decisions: [${JSON.stringify(kept)}],
}));
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
  });
  const run = await cli(target, ['start', 'smoke']);
  expect(run.exitCode, `${run.stdout}\n${run.stderr}`).toBe(0);
  const sessions = readdirSync(sessionsRoot(target.projectDir));
  expect(sessions).toHaveLength(1);
  const sessionId = sessions[0];
  if (sessionId === undefined) throw new Error('Missing session');
  return {
    state: readState(target, sessionId),
    reviewPrompt: readFileSync(reviewPath, 'utf8'),
    attempts: readFileSync(attemptsPath, 'utf8').length,
  };
}

describe('e2e: a declared decision', () => {
  it('lands in the plan ledger with its task id, with no consult, and the reviewer reads it as unconfirmed', async () => {
    const { state, reviewPrompt, attempts } = await runDeclaredDecision();

    expect(state.phase).toBe('complete');
    expect(attempts).toBe(1);
    expect(state.plan?.decisions).toEqual([{ text: `${kept.what} — ${kept.why}`, taskId: 'T001' }]);
    expect(reviewPrompt).toContain('Nobody confirmed these decisions');
    expect(reviewPrompt).toContain(`- ${kept.what} — ${kept.why} (T001)`);
  });
});
