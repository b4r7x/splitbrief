import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { REVIEW_FILE, STATE_FILE, sessionDir, sessionsRoot } from '../../../src/core/paths.js';
import { HeadlessJsonRecordSchema } from '../../../src/engine/events/public-json.js';
import { checkoutEntries } from '#testing/helpers/checkout.js';
import { activateSafeCliShimPath } from '#testing/helpers/compatible-cli-shim.js';
import { makePlanProposal, makeTaskSpec } from '#testing/helpers/factories/plan.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { passingVerdict } from '#testing/helpers/typed-planner.js';
import { cli, createStopContinueFixture, readState } from '../helpers/stop-continue-fixture.js';

/**
 * The project gate: red in the run and at the run base, with one output line that names no failing
 * test and no file position, so SPLITBRIEF cannot show it is the same failure.
 */
const RED_FILE = 'tools/run-specs.mjs';
const RED_COMMAND = `node ${RED_FILE}`;
const RED_LINE = 'Error: 2 specs failed';
const RED_SOURCE = `console.error(${JSON.stringify(RED_LINE)});
process.exitCode = 1;
`;
const RED_CHECK = `V1 failed · ${RED_COMMAND} · ${RED_LINE}`;
const ACCEPTED_SENTENCE = `Run accepted as is with 1 red check: ${RED_CHECK}.`;

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
const QUESTION = 'Is V1 the right gate command?';

const brief = makeTaskSpec({
  id: 'T001',
  title: 'Add the total helper',
  intent: 'Return the sum of two numbers.',
  criteria: ['C1'],
  suggestedFiles: [TOTAL_FILE, TOTAL_TEST_FILE],
  checks: [{ id: 'T001-K1', kind: 'test', value: TOTAL_TEST_FILE }],
});
const plan = makePlanProposal({
  summary: 'Add a total helper with its test.',
  decisions: [],
  criteria: [{ id: 'C1', text: 'total returns the sum.', checkIds: ['T001-K1'] }],
  gate: [RED_COMMAND],
  tasks: [brief],
});
/** The reviewer passes every task and criterion, rejects no red input and asks a question. */
const review = {
  ...passingVerdict({ kind: 'final', taskIds: [brief.id], criterionIds: ['C1'] }),
  ask: { question: QUESTION, whyOnlyUserCanAnswer: 'Only you know the gate.' },
};

const PLANNER_SCRIPT = `const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString('utf8');
if (prompt.includes('# Final Implementation Review')) {
  process.stdout.write(${JSON.stringify(JSON.stringify(review))});
} else if (prompt.includes('# Plan the change')) {
  process.stdout.write(${JSON.stringify(JSON.stringify({ result: plan }))});
} else {
  throw new Error('Unexpected prompt: ' + prompt);
}
`;

const IMPLEMENTER_SCRIPT = `import { mkdirSync, writeFileSync } from 'node:fs';
for await (const chunk of process.stdin) void chunk;
mkdirSync('src', { recursive: true });
writeFileSync(${JSON.stringify(TOTAL_FILE)}, ${JSON.stringify(TOTAL_SOURCE)});
writeFileSync(${JSON.stringify(TOTAL_TEST_FILE)}, ${JSON.stringify(TOTAL_TEST_SOURCE)});
console.log('Implemented ${brief.id}');
`;

/** Rewrites the fixture's one commit so the run base also holds the red script. */
function commitRedOnBase(projectDir: string): void {
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: projectDir, encoding: 'utf8' })
    .split('\0')
    .filter((path) => path !== '');
  const files: Record<string, string> = {};
  for (const path of tracked) files[path] = readFileSync(join(projectDir, path), 'utf8');
  createTestGitRepo(projectDir, { ...files, [RED_FILE]: RED_SOURCE });
}

/** The records of a `--json` stdout: each line is one public record. */
function jsonRecords(stdout: string) {
  return stdout
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => HeadlessJsonRecordSchema.parse(JSON.parse(line)));
}

it('e2e: the halt names --action accept-as-is, which accepts a final review that a red check blocks, --action apply refuses the accepted run, and --action apply-as-is names the red check before it writes the changes', {
  timeout: 300_000,
}, async () => {
  const target = createStopContinueFixture(() => '');
  commitRedOnBase(target.projectDir);
  const restorePath = activateSafeCliShimPath(target.tmpDir);
  const plannerPath = join(target.tmpDir, 'planner.mjs');
  const implementerPath = join(target.tmpDir, 'implementer.mjs');
  const offlinePath = join(target.tmpDir, 'offline.mjs');
  writeFileSync(plannerPath, PLANNER_SCRIPT);
  writeFileSync(implementerPath, IMPLEMENTER_SCRIPT);
  writeFileSync(
    offlinePath,
    "globalThis.fetch = async () => { throw new Error('E2E network disabled'); };\n",
  );
  vi.stubEnv('NODE_OPTIONS', `--import=${offlinePath}`);
  const config = loadConfig(target.projectDir).config;
  if (config.planner.kind !== 'shell' || config.implementer.kind !== 'agent') {
    throw new Error('Expected local shell and agent fixture runners');
  }
  writeConfig(target.projectDir, {
    ...config,
    planner: { ...config.planner, args: [plannerPath] },
    implementer: { ...config.implementer, args: [implementerPath] },
    workflow: { ...config.workflow, approve: 'none' },
    validation: { ...config.validation, endChecks: true, testCommand: 'node --test' },
  });
  const checkoutBeforeRun = checkoutEntries(target.projectDir);
  try {
    const run = await cli(target, ['start', 'total'], { json: true, timeoutMs: 150_000 });
    expect(run.exitCode, `${run.stdout}\n${run.stderr}`).toBe(1);
    const sessions = readdirSync(sessionsRoot(target.projectDir));
    expect(sessions).toHaveLength(1);
    const sessionId = sessions[0];
    if (sessionId === undefined) throw new Error('Missing session');
    expect(
      jsonRecords(run.stdout).filter((record) => record.type === 'recovery_required'),
    ).toMatchObject([
      {
        sessionId,
        reason: 'review-failed',
        question: QUESTION,
        availableActions: expect.arrayContaining(['accept-as-is']),
      },
    ]);
    const applyAsIs = `splitbrief continue ${sessionId} --action apply-as-is`;
    const acceptLine = run.stderr.split('\n').find((line) => line.startsWith('Accept as is: '));
    expect(acceptLine, run.stderr).toBe(
      `Accept as is: splitbrief continue ${sessionId} --action accept-as-is [--plain|--json]`,
    );
    const acceptArgs = (acceptLine ?? '')
      .replace(/^Accept as is: splitbrief /, '')
      .replace(/ \[--plain\|--json\]$/, '')
      .split(' ');

    const accepted = await cli(target, acceptArgs, { json: true, timeoutMs: 60_000 });
    expect(accepted.exitCode, `${accepted.stdout}\n${accepted.stderr}`).toBe(0);
    expect(
      jsonRecords(accepted.stdout).filter((record) => record.type === 'ready_to_apply'),
    ).toMatchObject([{ sessionId, override: true, applyCommand: applyAsIs }]);
    const acceptedLines = accepted.stderr.split('\n');
    const acceptedAt = acceptedLines.indexOf(ACCEPTED_SENTENCE);
    expect(acceptedAt, accepted.stderr).toBeGreaterThan(-1);
    expect(
      acceptedLines.findIndex((line) => line.includes(applyAsIs)),
      accepted.stderr,
    ).toBeGreaterThan(acceptedAt);

    const statePath = join(sessionDir(target.projectDir, sessionId), STATE_FILE);
    const stateAccepted = readFileSync(statePath, 'utf8');
    const refused = await cli(target, ['continue', sessionId, '--action', 'apply']);
    expect(refused.exitCode, `${refused.stdout}\n${refused.stderr}`).toBe(1);
    expect(refused.stderr).toContain(
      `Run ${sessionId} was accepted as is with 1 red check; apply it as is with: ${applyAsIs}`,
    );
    expect(readFileSync(statePath, 'utf8')).toBe(stateAccepted);
    expect(checkoutEntries(target.projectDir)).toEqual(checkoutBeforeRun);

    const applied = await cli(target, ['continue', sessionId, '--action', 'apply-as-is']);
    expect(applied.exitCode, `${applied.stdout}\n${applied.stderr}`).toBe(0);
    const appliedLines = applied.stderr.split('\n');
    const namedAt = appliedLines.indexOf(ACCEPTED_SENTENCE);
    expect(namedAt, applied.stderr).toBeGreaterThan(-1);
    expect(
      appliedLines.indexOf('Applied 2 files to your checkout.'),
      applied.stderr,
    ).toBeGreaterThan(namedAt);
    expect(readFileSync(join(target.projectDir, TOTAL_FILE), 'utf8')).toBe(TOTAL_SOURCE);
    expect(readFileSync(join(target.projectDir, TOTAL_TEST_FILE), 'utf8')).toBe(TOTAL_TEST_SOURCE);
    expect(readState(target, sessionId).closed?.as).toBe('applied');
    expect(
      readFileSync(join(sessionDir(target.projectDir, sessionId), REVIEW_FILE), 'utf8'),
    ).toContain(
      [
        '**Accepted as is by you**',
        '',
        'The planner did not accept this result. You accepted it as is, with 1 red check:',
        '',
        `- ${RED_CHECK}`,
      ].join('\n'),
    );
  } finally {
    vi.unstubAllEnvs();
    restorePath();
    cleanupTempDir(target.tmpDir);
  }
});
