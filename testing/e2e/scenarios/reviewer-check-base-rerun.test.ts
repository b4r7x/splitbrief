import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { readEvidenceLedger } from '../../../src/core/evidence/ledger-storage.js';
import {
  reviewPacketJsonPath,
  reviewPacketMarkdownPath,
  sessionsRoot,
} from '../../../src/core/paths.js';
import { ReviewPacketSchema } from '../../../src/core/schemas/review-packet.js';
import { deriveRunStatus } from '../../../src/core/sessions/run-status.js';
import { readRunEvents } from '../../../src/engine/events/replay.js';
import { suiteStatusParts } from '../../../src/features/workflow/display/phase-verb.js';
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
 * The committed red the run base already holds. It sits outside `node --test` discovery, so the
 * brief's own test check never runs it; only the reviewer's chosen command does.
 */
const RED_FILE = 'legacy/report-check.mjs';
const RED_COMMAND = `node ${RED_FILE}`;
const RED_KEY = `${RED_FILE}:4:3 AssertionError: legacy report total expected 3, received 2`;
const RED_SOURCE = `console.error(${JSON.stringify(RED_KEY)});
process.exitCode = 1;
`;

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
  commands: [
    {
      id: 'V1',
      command: RED_COMMAND,
      reason: 'The project verifies its report total with this script.',
    },
  ],
  declined: [],
  reason: null,
};
const verdict = passingVerdict({ kind: 'final', taskIds: [brief.id], criterionIds: ['C1'] });

type Call = { kind: string; prompt?: string };

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

describe('e2e: reviewer check base re-run', { timeout: 240_000 }, () => {
  it('marks a red the run base already holds pre-existing and does not blame the run', async () => {
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
    writeFileSync(
      plannerPath,
      `import { appendFileSync } from 'node:fs';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString('utf8');
let kind;
let answer;
if (prompt.includes('# Choose the checks for this review')) {
  kind = 'review-checks';
  answer = ${JSON.stringify(reviewChecksPlan)};
} else if (prompt.includes('# Final Implementation Review')) {
  kind = 'final-review';
  answer = ${JSON.stringify(verdict)};
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

    const run = await cli(target, ['start', 'total'], { timeoutMs: 120_000 });
    expect(run.exitCode, `${run.stdout}\n${run.stderr}`).toBe(0);

    assertPlainStdout(run.stdout);
    const lines = run.stdout.split('\n').map((line) => line.trim());
    expect(lines).toContain(`task ${brief.id}: done (no checks)`);
    expect(lines).toContain(`reviewer check V1: failed (${RED_COMMAND})`);
    expect(lines).toContain(
      "base re-run V1: pre-existing · the failure also fails before this run's changes",
    );

    expect(readCalls(callsPath).map((call) => call.kind)).toEqual([
      'plan',
      'implement',
      'review-checks',
      'final-review',
    ]);

    const sessions = readdirSync(sessionsRoot(target.projectDir));
    expect(sessions).toHaveLength(1);
    const sessionId = sessions[0];
    if (sessionId === undefined) throw new Error('Missing session');
    const ref = { projectDir: target.projectDir, sessionId };

    const replay = await readRunEvents(ref);
    expect(replay.diagnostics.skipped).toBe(0);
    const events = replay.events;

    const planned = events.filter((event) => event.type === 'review_checks');
    expect(planned).toHaveLength(1);
    expect(planned[0]).toMatchObject({
      scope: 'final',
      status: 'planned',
      commands: [{ id: 'V1', command: RED_COMMAND }],
    });

    const rows = events.flatMap((event) =>
      event.type === 'full_suite' && event.id === 'V1' ? [event] : [],
    );
    expect(rows.map((row) => ({ moment: row.moment, status: row.status }))).toEqual([
      { moment: 'pre-review', status: 'running' },
      { moment: 'pre-review', status: 'done' },
      { moment: 'base', status: 'running' },
      { moment: 'base', status: 'done' },
    ]);
    expect(rows[1]).toMatchObject({ command: RED_COMMAND, passed: false });
    const baseDone = rows[3];
    expect(baseDone).toMatchObject({
      command: RED_COMMAND,
      passed: false,
      newFailures: 0,
      preExisting: 1,
    });
    expect(baseDone).not.toHaveProperty('notVerified');
    expect(baseDone).not.toHaveProperty('detail');

    const baseRunning = rows[2];
    if (baseRunning === undefined) throw new Error('Missing base re-run row');
    expect(
      suiteStatusParts(baseRunning.phase, { id: 'V1', moment: 'base', command: RED_COMMAND })
        .map((part) => part.text)
        .join(''),
    ).toBe(`Review · Base re-run V1 · ${RED_COMMAND}`);

    const verdictPrompt = readCalls(callsPath).find((call) => call.kind === 'final-review')?.prompt;
    expect(verdictPrompt).toContain(
      `- V1 \`${RED_COMMAND}\`: failed, 0 new failure(s); 1 pre-existing (also red at the run base)`,
    );
    expect(verdictPrompt).toContain(
      `Pre-existing failures (also red at the run base):\n- ${RED_KEY}`,
    );
    expect(verdictPrompt).toContain(
      'A failure marked pre-existing also fails at the run base: raise no finding for it.',
    );
    expect(verdictPrompt).not.toContain(`Reviewer check V1 (${RED_COMMAND}) failed`);

    expect(events.some((event) => event.type === 'review_fix_started')).toBe(false);
    expect(
      events.filter((event) => event.type === 'review_completed' && event.scope === 'final'),
    ).toMatchObject([{ verdict: 'pass', findings: { blocking: 0 } }]);
    expect(events.filter((event) => event.type === 'workflow_complete')).toMatchObject([
      { review: 'passed' },
    ]);

    const state = readState(target, sessionId);
    expect(state.pendingTriage).toBeUndefined();
    expect(state.pendingRecovery).toBeUndefined();
    expect(state.tasks.map((task) => ({ id: task.id, status: task.status }))).toEqual([
      { id: brief.id, status: 'done' },
    ]);
    expect(state.reviewStatus).toBe('passed');
    expect(state.reviewChecks).toMatchObject({
      scope: 'final',
      plan: { commands: [{ id: 'V1', command: RED_COMMAND }] },
    });
    expect(state.reviewChecks?.skipped).toBeUndefined();
    expect(deriveRunStatus({ state, liveness: 'not-alive' })).toEqual({
      kind: 'ready-to-apply',
      override: false,
    });

    const logged = readEvidenceLedger(ref)?.tasks.flatMap((task) => task.checks ?? []) ?? [];
    expect(logged.find((entry) => entry.id === 'V1')).toMatchObject({
      command: RED_COMMAND,
      exitCode: 1,
      preExisting: [RED_KEY],
      base: { exitCode: 1 },
    });
    expect(logged.find((entry) => entry.id === 'T001-K1')).toMatchObject({ exitCode: 0 });

    const packet = ReviewPacketSchema.parse(
      JSON.parse(readFileSync(reviewPacketJsonPath(ref), 'utf8')),
    );
    expect(packet.checks.entries.find((entry) => entry.id === 'V1')).toMatchObject({
      taskId: brief.id,
      preExisting: [RED_KEY],
    });
    expect(readFileSync(reviewPacketMarkdownPath(ref), 'utf8')).toContain(
      `pre-existing (also red at the run base): ${RED_KEY}`,
    );

    const applied = await applyRun(target, sessionId);
    expect(applied.exitCode, applied.stderr).toBe(0);
    expect(applied.stderr).toContain('Applied 2 files to your checkout.');
    expect(readState(target, sessionId).closed?.as).toBe('applied');
    expect(readFileSync(join(target.projectDir, TOTAL_FILE), 'utf8')).toBe(TOTAL_SOURCE);
    expect(readFileSync(join(target.projectDir, TOTAL_TEST_FILE), 'utf8')).toBe(TOTAL_TEST_SOURCE);
    expect(readFileSync(join(target.projectDir, RED_FILE), 'utf8')).toBe(RED_SOURCE);
  });
});
