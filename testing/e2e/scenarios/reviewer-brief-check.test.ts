import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeConfig } from '../../../src/core/config/load/io.js';
import { readEvidenceLedger } from '../../../src/core/evidence/ledger-storage.js';
import { sessionsRoot } from '../../../src/core/paths.js';
import type { PlanProposal } from '../../../src/core/schemas/plan.js';
import { readRunEvents } from '../../../src/engine/events/replay.js';
import { activateSafeCliShimPath } from '#testing/helpers/compatible-cli-shim.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makePlanProposal, makeTaskSpec } from '#testing/helpers/factories/plan.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { passingVerdict } from '#testing/helpers/typed-planner.js';
import { cli } from '../helpers/stop-continue-fixture.js';

const COMMAND = 'npm run check:total';
const SOURCE = 'export const total = (a, b) => a + b;\n';
const CRITERIA = [
  { id: 'C1', text: 'Total adds positive and negative numbers.', checkIds: ['K1'] },
];
const PLAN = makePlanProposal({
  summary: 'Add a total helper.',
  criteria: CRITERIA,
  gate: [COMMAND],
  tasks: [
    makeTaskSpec({
      intent: 'Return the sum of two numbers.',
      title: 'Add the total helper',
      steps: ['Implement the total helper.'],
      suggestedFiles: ['src/total.mjs'],
      checks: [{ id: 'K1', kind: 'test', value: 'test/total.test.mjs', required: true }],
    }),
  ],
});

let tmpDir: string | undefined;
let restorePath: (() => void) | undefined;

afterEach(() => {
  restorePath?.();
  vi.unstubAllEnvs();
  if (tmpDir !== undefined) cleanupTempDir(tmpDir);
  tmpDir = undefined;
  restorePath = undefined;
});

/** Starts a run whose plan names the total check as its project gate; returns the final review prompt. */
async function runTotalGate(plan: PlanProposal): Promise<string> {
  tmpDir = createTempDir('splitbrief-reviewer-brief-check');
  const projectDir = join(tmpDir, 'project');
  const stateHome = join(tmpDir, 'state');
  const callsPath = join(tmpDir, 'reviewer-prompts.json');
  const plannerPath = join(tmpDir, 'planner.mjs');
  const implementerPath = join(tmpDir, 'implementer.mjs');
  const offlinePath = join(tmpDir, 'offline.mjs');
  const taskIds = plan.tasks.map((task) => task.id);
  mkdirSync(stateHome, { recursive: true });
  createTestGitRepo(projectDir, {
    'package.json': JSON.stringify({
      scripts: { 'check:total': 'node --test --test-reporter=tap test/total.test.mjs' },
    }),
    'test/total.test.mjs': `import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { total } from '../src/total.mjs';
test('total adds positive and negative numbers', () => {
  assert.equal(total(1, 2), 3);
  assert.equal(total(-4, 2), -2);
});
`,
  });
  restorePath = activateSafeCliShimPath(tmpDir);
  writeFileSync(
    offlinePath,
    "globalThis.fetch = async () => { throw new Error('E2E network disabled'); };\n",
  );
  vi.stubEnv('NODE_OPTIONS', `--import=${offlinePath}`);
  writeFileSync(
    plannerPath,
    `import { writeFileSync } from 'node:fs';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString('utf8');
let answer;
if (prompt.includes('# Final Implementation Review')) {
  writeFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ prompt }));
  answer = ${JSON.stringify(passingVerdict({ kind: 'final', taskIds, criterionIds: ['C1'] }))};
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
    `import { mkdirSync, writeFileSync } from 'node:fs';
for await (const chunk of process.stdin) void chunk;
mkdirSync('src', { recursive: true });
writeFileSync('src/total.mjs', ${JSON.stringify(SOURCE)});
console.log('Implemented total');
`,
  );
  writeConfig(
    projectDir,
    makeConfig({
      planner: { kind: 'shell', command: 'node', args: [plannerPath], outputFormat: 'text' },
      implementer: {
        kind: 'agent',
        command: 'node',
        args: [implementerPath],
        outputFormat: 'text',
        model: 'fixture',
        contextLength: 200_000,
      },
      workflow: { approve: 'none' },
      validation: { endChecks: true, testCommand: 'node --test' },
    }),
  );

  const run = await cli({ projectDir, stateHome }, ['start', 'Add the total helper']);
  expect(run.exitCode, `${run.stdout}\n${run.stderr}`).toBe(0);

  const sessions = readdirSync(sessionsRoot(projectDir));
  expect(sessions).toHaveLength(1);
  const sessionId = sessions[0];
  if (sessionId === undefined) throw new Error('Missing session');
  const ref = { projectDir, sessionId };
  const { events, diagnostics } = await readRunEvents(ref);
  expect(diagnostics.skipped).toBe(0);
  expect(events.filter((event) => event.type === 'review_checks')).toEqual([]);
  expect(events.filter((event) => event.type === 'full_suite' && event.id === 'V1')).toMatchObject([
    { id: 'V1', command: COMMAND, moment: 'pre-review', status: 'running' },
    { id: 'V1', command: COMMAND, moment: 'pre-review', status: 'done', passed: true },
  ]);
  expect(
    readEvidenceLedger(ref)
      ?.tasks.flatMap((task) => task.checks ?? [])
      .find((check) => check.id === 'V1'),
  ).toMatchObject({ command: COMMAND, exitCode: 0, output: expect.stringContaining('# pass 1') });
  expect(events.filter((event) => event.type === 'workflow_complete')).toMatchObject([
    { review: 'passed' },
  ]);
  return JSON.parse(readFileSync(callsPath, 'utf8')).prompt;
}

describe('e2e: the project gate the plan names', () => {
  it('runs the gate before the final review, gives the reviewer its result and records it', async () => {
    const prompt = await runTotalGate(PLAN);
    expect(prompt).toContain(`- V1 \`${COMMAND}\`: passed`);
  });
});
