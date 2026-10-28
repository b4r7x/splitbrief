import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import {
  REVIEW_FILE,
  REVIEW_JSON_FILE,
  sessionDir,
  sessionsRoot,
} from '../../../src/core/paths.js';
import type { ReviewAnswer } from '../../../src/core/schemas/review.js';
import { deriveRunStatus } from '../../../src/core/sessions/run-status.js';
import { readRunEvents } from '../../../src/engine/events/replay.js';
import { activateSafeCliShimPath } from '#testing/helpers/compatible-cli-shim.js';
import { makePlanProposal, makeTaskSpec } from '#testing/helpers/factories/plan.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { passingVerdict } from '#testing/helpers/typed-planner.js';
import { assertPlainStdout } from '../helpers/run-dir-assertions.js';
import {
  applyRun,
  cli,
  createStopContinueFixture,
  readState,
  type StopContinueFixture,
} from '../helpers/stop-continue-fixture.js';

/**
 * A wrong command the reviewer chooses: red in the run and at the run base, with an error line but
 * no failing test and no file position, so SPLITBRIEF cannot show it is the same failure.
 */
const RED_FILE = 'tools/run-specs.mjs';
const RED_COMMAND = `node ${RED_FILE}`;
const RED_LINE = "Error: Cannot find module 'specs'";
const RED_SOURCE = `console.error(${JSON.stringify(RED_LINE)});
console.error("  code: 'MODULE_NOT_FOUND'");
process.exitCode = 1;
`;
const NOT_VERIFIED = `both runs exited with code 1: ${RED_LINE}`;

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

const brief = makeTaskSpec({
  id: 'T001',
  title: 'Add the total helper',
  intent: 'Return the sum of two numbers.',
  criteria: ['C1'],
  suggestedFiles: [TOTAL_FILE, TOTAL_TEST_FILE],
  checks: [{ id: 'T001-K1', kind: 'test', value: TOTAL_TEST_FILE, required: true }],
});
const plan = makePlanProposal({
  summary: 'Add a total helper with its test.',
  decisions: [],
  criteria: [{ id: 'C1', text: 'total returns the sum.', checkIds: ['T001-K1'] }],
  tasks: [brief],
});
const reviewChecksPlan = {
  commands: [{ id: 'V1', command: RED_COMMAND, reason: 'Runs the specs directly.' }],
  declined: [],
  reason: null,
};
const note: ReviewAnswer['findings'][number] = {
  id: 'F1',
  kind: 'question',
  severity: 'minor',
  taskId: null,
  file: null,
  line: null,
  text: 'The workspace holds files no task wrote.',
  acceptance: null,
  checkIds: null,
  criterionId: null,
};
const verdict = {
  ...passingVerdict({ kind: 'final', taskIds: [brief.id], criterionIds: ['C1'] }),
  findings: [note],
};
/** One line of the review prompt's Pending Inputs section per red reviewer check input. */
const PENDING_INPUT = /^- \*\*(\S+)\*\* \(check · defect\)/gm;

type Answer = 'reject' | 'verify';
type Call = { kind: string; inputs?: string[]; prompt?: string };

let fixture: StopContinueFixture | undefined;
let restorePath: (() => void) | undefined;

afterEach(() => {
  restorePath?.();
  vi.unstubAllEnvs();
  if (fixture !== undefined) cleanupTempDir(fixture.tmpDir);
  fixture = undefined;
  restorePath = undefined;
});

/** Rewrites the fixture's one commit so the run base also holds the red script. */
function commitRedOnBase(projectDir: string): void {
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: projectDir, encoding: 'utf8' })
    .split('\0')
    .filter((path) => path !== '');
  const files: Record<string, string> = {};
  for (const path of tracked) files[path] = readFileSync(join(projectDir, path), 'utf8');
  createTestGitRepo(projectDir, { ...files, [RED_FILE]: RED_SOURCE });
}

function readCalls(path: string): Call[] {
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}

/** The reviewer answers every pending red input the way `answer` says: reject it, or verify it. */
function plannerScript(callsPath: string, answer: Answer): string {
  return `import { appendFileSync } from 'node:fs';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString('utf8');
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
  call = { kind: 'review-checks' };
  answer = ${JSON.stringify(reviewChecksPlan)};
} else if (prompt.includes('# Final Implementation Review')) {
  const inputs = pendingInputs();
  call = { kind: 'final-review', inputs, prompt };
  answer = { ...${JSON.stringify(verdict)} };
  if (${JSON.stringify(answer)} === 'reject') {
    answer.rejected = inputs.map((findingId) => ({
      findingId,
      reason: 'V1 is a wrong command, not a defect in the code: it names no spec file. The brief check T001-K1 passed.',
    }));
  } else {
    answer.verify = inputs.map((findingId) => ({ findingId, checkIds: ['V1'] }));
  }
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

async function startRun(answer: Answer) {
  fixture = createStopContinueFixture(() => '');
  const target = fixture;
  commitRedOnBase(target.projectDir);
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
  writeFileSync(plannerPath, plannerScript(callsPath, answer));
  writeFileSync(
    implementerPath,
    `import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
for await (const chunk of process.stdin) void chunk;
appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ kind: 'implement' }) + '\\n');
mkdirSync('src', { recursive: true });
writeFileSync(${JSON.stringify(TOTAL_FILE)}, ${JSON.stringify(TOTAL_SOURCE)});
writeFileSync(${JSON.stringify(TOTAL_TEST_FILE)}, ${JSON.stringify(TOTAL_TEST_SOURCE)});
console.log('Implemented ${brief.id}');
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
    workflow: { ...config.workflow, approve: 'none' },
    validation: {
      ...config.validation,
      endChecks: true,
      approveChecks: 'auto',
      testCommand: 'node --test',
    },
  });

  const run = await cli(target, ['start', 'total'], { timeoutMs: 150_000 });
  const sessions = readdirSync(sessionsRoot(target.projectDir));
  expect(sessions).toHaveLength(1);
  const sessionId = sessions[0];
  if (sessionId === undefined) throw new Error('Missing session');
  const ref = { projectDir: target.projectDir, sessionId };
  const replay = await readRunEvents(ref);
  expect(replay.diagnostics.skipped).toBe(0);
  return { target, run, sessionId, events: replay.events, calls: readCalls(callsPath) };
}

describe('e2e: the reviewer decides a red reviewer check', { timeout: 300_000 }, () => {
  it('passes the review and applies the run when the reviewer rejects the red input', async () => {
    const { target, run, sessionId, events, calls } = await startRun('reject');
    expect(run.exitCode, `${run.stdout}\n${run.stderr}`).toBe(0);

    expect(calls.map((call) => call.kind)).toEqual([
      'plan',
      'implement',
      'review-checks',
      'final-review',
    ]);
    expect(calls[3]?.inputs).toEqual(['V1.1']);

    const base = events.find(
      (event) => event.type === 'full_suite' && event.moment === 'base' && event.status === 'done',
    );
    expect(base).toMatchObject({ id: 'V1', passed: false, notVerified: 1, detail: NOT_VERIFIED });

    const reason =
      'V1 is a wrong command, not a defect in the code: it names no spec file. The brief check T001-K1 passed.';
    expect(
      events.filter((event) => event.type === 'review_completed' && event.scope === 'final'),
    ).toMatchObject([
      {
        verdict: 'pass-with-notes',
        findings: { blocking: 0, minor: 1 },
        setAside: [{ id: 'V1.1', reason }],
      },
    ]);
    expect(events.filter((event) => event.type === 'workflow_complete')).toMatchObject([
      { review: 'passed' },
    ]);
    assertPlainStdout(run.stdout);
    expect(run.stdout).toContain(`review: Set aside V1.1: ${reason}`);
    expect(
      readFileSync(join(sessionDir(target.projectDir, sessionId), REVIEW_FILE), 'utf8'),
    ).toContain(`- Set aside V1.1: ${reason}`);
    expect(events.some((event) => event.type === 'recovery_prompted')).toBe(false);
    expect(events.some((event) => event.type === 'error')).toBe(false);

    const state = readState(target, sessionId);
    expect(state.pendingRecovery).toBeUndefined();
    expect(state.pendingTriage).toBeUndefined();
    expect(state.reviewStatus).toBe('passed');
    expect(state.review).toMatchObject({ outcome: 'pass-with-notes' });
    expect(state.review?.redInputs).toBeUndefined();
    expect(state.triage?.at(-1)?.result.rejected.map((entry) => entry.findingId)).toEqual(['V1.1']);
    expect(deriveRunStatus({ state, liveness: 'not-alive' })).toEqual({
      kind: 'ready-to-apply',
      override: false,
    });

    const applied = await applyRun(target, sessionId);
    expect(applied.exitCode, applied.stderr).toBe(0);
    expect(readState(target, sessionId).closed?.as).toBe('applied');
    expect(readFileSync(join(target.projectDir, TOTAL_FILE), 'utf8')).toBe(TOTAL_SOURCE);
  });

  it('keeps a red input the reviewer does not reject blocking, with Fix again and no Accept as is', async () => {
    const { target, run, sessionId, events, calls } = await startRun('verify');
    expect(run.exitCode, `${run.stdout}\n${run.stderr}`).not.toBe(0);

    expect(calls.map((call) => call.kind)).toEqual([
      'plan',
      'implement',
      'review-checks',
      'final-review',
      'review-checks',
      'final-review',
      'review-checks',
      'final-review',
    ]);

    const reviews = events.filter(
      (event) => event.type === 'review_completed' && event.scope === 'final',
    );
    expect(reviews).toHaveLength(3);
    for (const review of reviews) {
      expect(review).toMatchObject({ verdict: 'fail', findings: { blocking: 1, minor: 1 } });
    }
    expect(events.filter((event) => event.type === 'error').map((event) => event.message)).toEqual([
      'Final review failed after 2 fix cycles; see review.md',
    ]);
    expect(events.some((event) => event.type === 'workflow_complete')).toBe(false);

    const state = readState(target, sessionId);
    expect(state.reviewStatus).toBeUndefined();
    expect(state.pendingTriage?.inputs.map((input) => input.id)).toEqual(['V1.1']);
    const dir = sessionDir(target.projectDir, sessionId);
    expect(JSON.parse(readFileSync(join(dir, REVIEW_JSON_FILE), 'utf8'))).toMatchObject({
      outcome: 'fail',
      redInputs: [{ id: 'V1.1' }],
    });
    const reviewText = readFileSync(join(dir, REVIEW_FILE), 'utf8');
    expect(reviewText).toContain('### Verdict\n\nfail\n');
    expect(reviewText).toMatch(
      /^- V1\.1: Reviewer check V1 \(node tools\/run-specs\.mjs\) failed and/m,
    );
    expect(state.pendingRecovery).toMatchObject({
      reason: 'review-failed',
      availableActions: ['revise', 'end-run'],
    });
    expect(deriveRunStatus({ state, liveness: 'not-alive' }).kind).toBe('open');
  });
});
