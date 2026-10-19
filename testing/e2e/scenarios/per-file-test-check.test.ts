import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { sessionsRoot } from '../../../src/core/paths.js';
import type { Check } from '../../../src/core/schemas/task.js';
import type { ReviewChecksPlan } from '../../../src/core/schemas/review.js';
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

let fixture: StopContinueFixture | undefined;
let restorePath: (() => void) | undefined;

afterEach(() => {
  restorePath?.();
  vi.unstubAllEnvs();
  if (fixture !== undefined) cleanupTempDir(fixture.tmpDir);
  fixture = undefined;
  restorePath = undefined;
});

function git(cwd: string, args: readonly string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

/**
 * One task writes `src/alpha.mjs` and its test, checked by the given checks. The planner answers
 * the plan, both reviews and the reviewer's check choice; a plan repair is recorded, never answered.
 */
async function runAlpha(opts: {
  checks: readonly Check[];
  reviewChecks?: ReviewChecksPlan;
  testCommand?: string;
  projectFiles?: Readonly<Record<string, string>>;
}) {
  fixture = createStopContinueFixture(() => '', { isolation: 'none' });
  const target = fixture;
  restorePath = activateSafeCliShimPath(target.tmpDir);
  const files = opts.projectFiles ?? {};
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(target.projectDir, file)), { recursive: true });
    writeFileSync(join(target.projectDir, file), text);
  }
  if (Object.keys(files).length > 0) {
    git(target.projectDir, ['add', ...Object.keys(files)]);
    git(target.projectDir, ['commit', '--quiet', '-m', 'add the project tests']);
  }
  const callsPath = join(target.tmpDir, 'calls.jsonl');
  const plannerPath = join(target.tmpDir, 'planner.mjs');
  const implementerPath = join(target.tmpDir, 'implementer.mjs');
  const offlinePath = join(target.tmpDir, 'offline.mjs');
  writeFileSync(
    offlinePath,
    "globalThis.fetch = async () => { throw new Error('E2E network disabled'); };\n",
  );
  vi.stubEnv('NODE_OPTIONS', `--import=${offlinePath}`);
  const plan = makePlanProposal({
    summary: 'Add a tested alpha value.',
    decisions: [],
    criteria: [
      { id: 'C1', text: 'Alpha is the string alpha.', checkIds: opts.checks.map((c) => c.id) },
    ],
    tasks: [
      makeTaskSpec({
        id: 'T001',
        title: 'Add the alpha value',
        intent: 'Return the alpha value.',
        criteria: ['C1'],
        suggestedFiles: ['src/alpha.mjs', 'src/alpha.test.mjs'],
        checks: [...opts.checks],
      }),
    ],
  });
  const passing = passingVerdict({ kind: 'final', taskIds: ['T001'], criterionIds: ['C1'] });
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
  answer = ${JSON.stringify(opts.reviewChecks ?? null)};
} else if (prompt.includes('# Task Implementation Review')) {
  kind = 'task-review';
  answer = ${JSON.stringify(passing)};
} else if (prompt.includes('# Final Implementation Review')) {
  kind = 'final-review';
  answer = ${JSON.stringify(passing)};
} else if (prompt.includes("The plan failed SPLITBRIEF's checks")) {
  kind = 'plan-repair';
  answer = { result: null };
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
    `import { mkdirSync, writeFileSync } from 'node:fs';
for await (const chunk of process.stdin) void chunk;
mkdirSync('src', { recursive: true });
writeFileSync('src/alpha.mjs', "export const alpha = 'alpha';\\n");
writeFileSync(
  'src/alpha.test.mjs',
  "import { strict as assert } from 'node:assert';\\nimport { alpha } from './alpha.mjs';\\nassert.equal(alpha, 'alpha');\\n",
);
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
    workflow: { ...config.workflow, review: 'task', approve: 'none' },
    validation: {
      ...config.validation,
      testCommand: opts.testCommand,
      endChecks: opts.reviewChecks !== undefined,
      approveChecks: 'auto',
    },
  });
  const run = await cli(target, ['start', 'smoke']);
  const sessions = readdirSync(sessionsRoot(target.projectDir));
  expect(sessions).toHaveLength(1);
  const sessionId = sessions[0];
  if (sessionId === undefined) throw new Error('Missing session');
  const replay = await readRunEvents({ projectDir: target.projectDir, sessionId });
  expect(replay.diagnostics.skipped).toBe(0);
  const calls: string[] = readFileSync(callsPath, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line).kind);
  return { run, state: readState(target, sessionId), events: replay.events, calls };
}

describe('e2e: a plan with a per-file test check', () => {
  it('runs node --test on one test file as a plan check and node --check as reviewer checks', async () => {
    const parseOnly = ['node --check src/alpha.mjs', 'node -c src/alpha.mjs'];
    const { run, state, events, calls } = await runAlpha({
      testCommand: 'node --test',
      checks: [
        { id: 'K1', kind: 'test', value: 'src/alpha.test.mjs', required: true },
        { id: 'K2', kind: 'cmd', value: 'node --test src/alpha.test.mjs', required: true },
      ],
      reviewChecks: {
        commands: parseOnly.map((command, index) => ({
          id: `V${index + 1}`,
          command,
          reason: 'Check the syntax of the new module.',
        })),
        declined: [],
        reason: null,
      },
    });

    expect(run.exitCode, `${run.stdout}\n${run.stderr}`).toBe(0);
    expect(state.phase).toBe('complete');
    expect(state.reviewStatus).toBe('passed');
    expect(calls).not.toContain('plan-repair');
    expect(state.tasks[0]?.checkResults).toEqual([
      { id: 'K1', status: 'pass' },
      { id: 'K2', status: 'pass' },
    ]);
    expect(
      events.find((event) => event.type === 'full_suite' && event.status === 'refused'),
    ).toBeUndefined();
    for (const [index, command] of parseOnly.entries()) {
      const rows = events.filter(
        (event) =>
          event.type === 'full_suite' && event.id === `V${index + 1}` && event.status === 'done',
      );
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) expect(row).toMatchObject({ command, passed: true });
    }
  });

  it('runs a chained package test script as written, and a test under test/ as a cmd check', async () => {
    const { run, state, events, calls } = await runAlpha({
      projectFiles: {
        'package.json': `${JSON.stringify({
          name: 'alpha',
          private: true,
          scripts: { test: 'node --test src/alpha.test.mjs && node --test test/unit/beta.mjs' },
        })}\n`,
        'test/unit/beta.mjs': "import { strict as assert } from 'node:assert';\nassert.ok(true);\n",
      },
      checks: [
        { id: 'K1', kind: 'test', value: 'src/alpha.test.mjs', required: true },
        { id: 'K2', kind: 'cmd', value: 'node --test test/unit/beta.mjs', required: true },
      ],
    });

    expect(run.exitCode, `${run.stdout}\n${run.stderr}`).toBe(0);
    expect(state.phase).toBe('complete');
    expect(calls).not.toContain('plan-repair');
    expect(state.tasks[0]?.checkResults).toEqual([
      { id: 'K1', status: 'pass' },
      { id: 'K2', status: 'pass' },
    ]);
    const rows = events.filter((event) => event.type === 'full_suite' && event.id === 'K1');
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row).toMatchObject({ command: 'npm test' });
  });

  it('runs a root test.js that no test pattern maps, and reaches the review', async () => {
    const { run, state, events, calls } = await runAlpha({
      projectFiles: {
        'package.json': `${JSON.stringify({
          name: 'alpha',
          private: true,
          scripts: { test: 'node --test' },
        })}\n`,
        'test.js':
          "const assert = require('node:assert');\nimport('./src/alpha.mjs').then((m) => assert.equal(m.alpha, 'alpha'));\n",
      },
      checks: [{ id: 'K1', kind: 'test', value: 'test.js', required: true }],
    });

    expect(run.exitCode, `${run.stdout}\n${run.stderr}`).toBe(0);
    expect(state.phase).toBe('complete');
    expect(state.reviewStatus).toBe('passed');
    expect(calls).toContain('final-review');
    expect(state.tasks[0]?.checkResults).toEqual([{ id: 'K1', status: 'pass' }]);
    const rows = events.filter((event) => event.type === 'full_suite' && event.id === 'K1');
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row).toMatchObject({ command: 'npm test -- test.js' });
  });

  it('reads a required check whose test script calls a missing program as not run, naming that program', async () => {
    const { run, state, events } = await runAlpha({
      projectFiles: {
        'package.json': `${JSON.stringify({
          name: 'alpha',
          private: true,
          scripts: { test: 'splitbrief-missing-runner' },
        })}\n`,
      },
      checks: [{ id: 'K1', kind: 'test', value: 'src/alpha.test.mjs', required: true }],
    });

    const rows = events.filter(
      (event) => event.type === 'full_suite' && event.id === 'K1' && event.status === 'not-run',
    );
    expect(rows.length, `${run.stdout}\n${run.stderr}`).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row).toMatchObject({ command: 'npm test -- src/alpha.test.mjs' });
      if (row.type !== 'full_suite') continue;
      expect(row.detail).toContain('splitbrief-missing-runner');
      expect(row.detail).not.toContain('npm not found');
    }
    expect(state.tasks[0]?.checkResults).toEqual([{ id: 'K1', status: 'not-runnable' }]);
    expect(
      events.filter(
        (event) =>
          event.type === 'recovery_prompted' && event.reason === 'required-checks-unrunnable',
      ),
    ).toHaveLength(1);
    expect(state.pendingRecovery?.reason).toBe('required-checks-unrunnable');
    expect(state.pendingRecovery?.message).toContain('K1: ');
    expect(state.pendingRecovery?.message).toContain('splitbrief-missing-runner');
    expect(state.pendingRecovery?.message).not.toContain('npm not found');
    expect(state.pendingRecovery?.details).toContain(
      'Install what is missing, then run the checks again.',
    );
  });
});
