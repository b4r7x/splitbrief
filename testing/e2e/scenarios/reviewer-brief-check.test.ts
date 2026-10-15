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
const BRIEF_REQUEST = `Reviewer: run ${COMMAND}.`;
const DECISION = 'Use the total check to verify negative numbers as well.';
const SOURCE = 'export const total = (a, b) => a + b;\n';
const CRITERIA = [
  { id: 'C1', text: 'Total adds positive and negative numbers.', checkIds: ['K1'] },
];
const taskSpec = (steps: string[]) =>
  makeTaskSpec({
    intent: 'Return the sum of two numbers.',
    title: 'Add the total helper',
    steps,
    suggestedFiles: ['src/total.mjs'],
    checks: [{ id: 'K1', kind: 'test', value: 'test/total.test.mjs', required: true }],
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

/** Starts a run whose reviewer chooses the total check only when its prompt carries `requires`. */
async function runChoosingTotalCheck(
  feature: string,
  plan: PlanProposal,
  requires: readonly string[],
): Promise<string> {
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
if (prompt.includes('# Choose the checks for this review')) {
  writeFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ prompt }));
  const requested = ${JSON.stringify(requires)}.every((text) => prompt.includes(text));
  answer = requested
    ? { commands: [{ id: 'V1', command: ${JSON.stringify(COMMAND)}, reason: 'The user requests the total check.' }], declined: [], reason: null }
    : { commands: [], declined: [], reason: 'No one requests a check.' };
} else if (prompt.includes('# Final Implementation Review')) {
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
      validation: { endChecks: true, approveChecks: 'auto', testCommand: 'node --test' },
    }),
  );

  const run = await cli({ projectDir, stateHome }, ['start', feature]);
  expect(run.exitCode, `${run.stdout}\n${run.stderr}`).toBe(0);

  const sessions = readdirSync(sessionsRoot(projectDir));
  expect(sessions).toHaveLength(1);
  const sessionId = sessions[0];
  if (sessionId === undefined) throw new Error('Missing session');
  const ref = { projectDir, sessionId };
  const { events, diagnostics } = await readRunEvents(ref);
  expect(diagnostics.skipped).toBe(0);
  expect(events.filter((event) => event.type === 'review_checks')).toMatchObject([
    { scope: 'final', status: 'planned', commands: [{ id: 'V1', command: COMMAND }] },
  ]);
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

describe('e2e: a reviewer check the user requests', () => {
  it('gives check selection the brief and decisions, then runs the check the brief requests', async () => {
    const prompt = await runChoosingTotalCheck(
      'Add the total helper',
      makePlanProposal({
        summary: 'Add a total helper.',
        decisions: [DECISION],
        criteria: CRITERIA,
        tasks: [taskSpec(['Implement the total helper.', BRIEF_REQUEST])],
      }),
      [BRIEF_REQUEST, DECISION],
    );
    expect(prompt).toContain('### Tasks');
    expect(prompt).toContain(BRIEF_REQUEST);
    expect(prompt).toContain('### Decisions');
    expect(prompt).toContain(DECISION);
  });

  it('gives check selection the request the run started with, then runs the check it names', async () => {
    const request = `Add the total helper. ${BRIEF_REQUEST}`;
    const prompt = await runChoosingTotalCheck(
      request,
      makePlanProposal({
        summary: 'Add a total helper.',
        criteria: CRITERIA,
        tasks: [taskSpec(['Implement the total helper.'])],
      }),
      [request],
    );
    expect(prompt).toContain(`## Request\n\n`);
    expect(prompt).toContain(`\n\`\`\`\n${request}\n\`\`\`\n`);
    expect(prompt.slice(prompt.indexOf('## Plan'))).not.toContain(COMMAND);
  });
});
