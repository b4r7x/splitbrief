import { chmodSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { sessionsRoot } from '../../../src/core/paths.js';
import { readRunEvents } from '../../../src/engine/events/replay.js';
import { activateSafeCliShimPath } from '#testing/helpers/compatible-cli-shim.js';
import { makePlanProposal, makeTaskSpec } from '#testing/helpers/factories/plan.js';
import type { PlanProposal } from '../../../src/core/schemas/plan.js';
import type { ReviewChecksPlan } from '../../../src/core/schemas/review.js';
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

function alphaPlan(k2: { value: string; required: boolean }) {
  return makePlanProposal({
    summary: 'Add a tested alpha value.',
    decisions: [],
    criteria: [{ id: 'C1', text: 'Alpha is the string alpha.', checkIds: ['K1', 'K2'] }],
    tasks: [
      makeTaskSpec({
        id: 'T001',
        title: 'Add the alpha value',
        intent: 'Return the alpha value.',
        criteria: ['C1'],
        suggestedFiles: ['src/alpha.mjs', 'src/alpha.test.mjs'],
        checks: [
          { id: 'K1', kind: 'test', value: 'src/alpha.test.mjs', required: true },
          { id: 'K2', kind: 'cmd', ...k2 },
        ],
      }),
    ],
  });
}

/**
 * The planner answers `plan` first and `repair` when SPLITBRIEF sends the plan back. A check the
 * plan command policy refuses must reach the record, the transcript and the reviewer as refused,
 * never as a failed check.
 */
async function runRefusedCheck(opts: {
  approve: 'plan' | 'none';
  plan: PlanProposal;
  repair?: PlanProposal;
  reviewChecks?: ReviewChecksPlan;
}) {
  fixture = createStopContinueFixture(() => '', { isolation: 'none' });
  const target = fixture;
  restorePath = activateSafeCliShimPath(target.tmpDir);
  const callsPath = join(target.tmpDir, 'calls.jsonl');
  const executedPath = join(target.tmpDir, 'refused-command-executed');
  for (const program of ['gradle', 'just']) {
    const path = join(target.tmpDir, program);
    writeFileSync(
      path,
      `#!${process.execPath}\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(executedPath)}, ${JSON.stringify(program)});\n`,
    );
    chmodSync(path, 0o755);
  }
  const plannerPath = join(target.tmpDir, 'planner.mjs');
  const implementerPath = join(target.tmpDir, 'implementer.mjs');
  const offlinePath = join(target.tmpDir, 'offline.mjs');
  writeFileSync(
    offlinePath,
    "globalThis.fetch = async () => { throw new Error('E2E network disabled'); };\n",
  );
  vi.stubEnv('NODE_OPTIONS', `--import=${offlinePath}`);
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
  answer = ${JSON.stringify(opts.reviewChecks)};
} else if (prompt.includes('# Task Implementation Review')) {
  kind = 'task-review';
  answer = ${JSON.stringify(passing)};
} else if (prompt.includes('# Final Implementation Review')) {
  kind = 'final-review';
  answer = ${JSON.stringify(passing)};
} else if (prompt.includes("The plan failed SPLITBRIEF's checks")) {
  kind = 'plan-repair';
  answer = ${JSON.stringify({ result: opts.repair ?? null })};
} else if (prompt.includes('# Plan the change')) {
  kind = 'plan';
  answer = ${JSON.stringify({ result: opts.plan })};
} else {
  throw new Error('Unexpected prompt: ' + prompt);
}
appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ kind, prompt }) + '\\n');
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
    workflow: { ...config.workflow, review: 'task', approve: opts.approve },
    validation: {
      ...config.validation,
      testCommand: 'node --test',
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
  const calls: Array<{ kind: string; prompt: string }> = readFileSync(callsPath, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  return { run, state: readState(target, sessionId), events: replay.events, calls, executedPath };
}

describe('e2e: a refused plan check', () => {
  it('names the task runner options in the transcript and review without executing them', async () => {
    const refusedChecks = [
      {
        id: 'V1',
        command: 'gradle --init-script setup.gradle test',
        detail: 'uses the code-loading option gradle --init-script',
      },
      {
        id: 'V2',
        command: 'just --shell node test',
        detail: 'uses the code-loading option just --shell',
      },
    ];
    const { run, state, events, calls, executedPath } = await runRefusedCheck({
      approve: 'none',
      plan: alphaPlan({ value: 'node --version', required: true }),
      reviewChecks: {
        commands: [
          ...refusedChecks.map(({ id, command }) => ({
            id,
            command,
            reason: 'Run the project checks.',
          })),
          { id: 'V3', command: 'node --version', reason: 'Check the Node runtime.' },
        ],
        declined: [],
        reason: null,
      },
    });

    expect(run.exitCode, `${run.stdout}\n${run.stderr}`).toBe(0);
    expect(state.phase).toBe('complete');
    expect(state.reviewStatus).toBe('passed');
    expect(existsSync(executedPath)).toBe(false);
    for (const { id, command, detail } of refusedChecks) {
      expect(
        events.filter(
          (event) => event.type === 'full_suite' && event.id === id && event.status === 'refused',
        ),
      ).toMatchObject([
        { command, detail, status: 'refused', moment: 'pre-review' },
        { command, detail, status: 'refused', moment: 'pre-review' },
      ]);
      expect(
        events.some(
          (event) => event.type === 'full_suite' && event.id === id && event.status === 'done',
        ),
      ).toBe(false);
      expect(run.stdout).toContain(detail);
      for (const review of calls.filter(
        (call) => call.kind === 'task-review' || call.kind === 'final-review',
      )) {
        expect(review.prompt).toContain(`- ${id} \`${command}\`: refused, ${detail}`);
        expect(review.prompt).not.toContain('runs inline code');
      }
    }
    expect(
      events.filter(
        (event) => event.type === 'full_suite' && event.id === 'V3' && event.status === 'done',
      ),
    ).toMatchObject([{ passed: true }, { passed: true }]);
  });

  it('records the reviewer option that was refused and continues with the admitted check', async () => {
    const command = 'node --require=./setup.js --test';
    const reason = 'uses the code-loading option node --require';
    const { run, state, events, calls } = await runRefusedCheck({
      approve: 'none',
      plan: alphaPlan({ value: 'node --version', required: true }),
      reviewChecks: {
        commands: [
          { id: 'V1', command, reason: 'Run the tests with the project setup.' },
          { id: 'V2', command: 'node --version', reason: 'Check the Node runtime.' },
        ],
        declined: [],
        reason: null,
      },
    });

    expect(run.exitCode, `${run.stdout}\n${run.stderr}`).toBe(0);
    expect(state.phase).toBe('complete');
    expect(state.reviewStatus).toBe('passed');
    const refused = events.filter(
      (event) => event.type === 'full_suite' && event.id === 'V1' && event.status === 'refused',
    );
    expect(refused).toHaveLength(2);
    expect(refused).toMatchObject([
      { command, moment: 'pre-review', detail: reason },
      { command, moment: 'pre-review', detail: reason },
    ]);
    expect(
      events.filter(
        (event) => event.type === 'full_suite' && event.id === 'V2' && event.status === 'done',
      ),
    ).toMatchObject([{ passed: true }, { passed: true }]);
    expect(
      events.some(
        (event) => event.type === 'full_suite' && event.id === 'V1' && event.status === 'done',
      ),
    ).toBe(false);
    const reviews = calls.filter(
      (call) => call.kind === 'task-review' || call.kind === 'final-review',
    );
    expect(reviews).toHaveLength(2);
    for (const review of reviews) {
      expect(review.prompt).toContain(`- V1 \`${command}\`: refused, ${reason}`);
      expect(review.prompt).not.toContain('runs inline code');
    }
  });

  it.each([
    ['node --test test/', 'passes an operand to node (test/)'],
    ['node --require=./setup.js --test', 'uses the code-loading option node --require'],
    ['python -m custom_check', 'runs a Python module outside the stack tools (custom_check)'],
    ['npx --package=tool check', 'uses the code-loading option npx --package'],
    [
      'just test lint',
      'passes extra arguments to just test; only one bare stage target is allowed',
    ],
    [
      'uv run --frozen pytest',
      'requires a Python stack tool directly after uv run (received --frozen)',
    ],
  ])('records the rule that refuses the discovered test command %s', async (command, reason) => {
    const plan = alphaPlan({ value: 'node --version', required: true });
    const { run, state, events, calls } = await runRefusedCheck({
      approve: 'none',
      plan: {
        ...plan,
        validation: { language: 'javascript', test: command, testPattern: '*.test.mjs' },
      },
    });

    expect(run.exitCode, `${run.stdout}\n${run.stderr}`).toBe(0);
    expect(state.phase).toBe('complete');
    expect(state.discoveredValidation?.testCommand).toBeUndefined();
    const warnings = events.flatMap((event) =>
      event.type === 'warning' && event.code === 'discovered_validation_refused'
        ? [event.message]
        : [],
    );
    expect(warnings).toEqual([
      `The test checks do not take ${command} from the planner (it ${reason}) and use config, the manifest or the stack default.`,
    ]);
    expect(calls.map((call) => call.kind)).toEqual(['plan', 'task-review', 'final-review']);
    expect(state.tasks[0]?.checkResults).toEqual([
      { id: 'K1', status: 'pass' },
      { id: 'K2', status: 'pass' },
    ]);
  });

  it('passes the run with a refused row and shows the reviewer a refused check, never a failed one', async () => {
    const { run, state, events, calls } = await runRefusedCheck({
      approve: 'plan',
      plan: alphaPlan({ value: 'npm run lint', required: false }),
    });
    const reason = 'runs an npm script, but package.json was not found';

    expect(run.exitCode, `${run.stdout}\n${run.stderr}`).toBe(0);
    expect(state.phase).toBe('complete');
    expect(state.reviewStatus).toBe('passed');
    expect(state.tasks[0]?.checkResults).toEqual([
      { id: 'K1', status: 'pass' },
      { id: 'K2', status: 'refused' },
    ]);
    expect(events.find((event) => event.type === 'checks_run')).toMatchObject({
      taskId: 'T001',
      results: [
        { id: 'K1', status: 'pass' },
        { id: 'K2', status: 'refused' },
      ],
    });
    const refusedRows = events.filter(
      (event) => event.type === 'full_suite' && event.id === 'K2' && event.status === 'refused',
    );
    expect(refusedRows.length).toBeGreaterThan(0);
    for (const row of refusedRows) {
      expect(row).toMatchObject({ moment: 'plan', command: 'npm run lint', detail: reason });
    }
    expect(
      events.find((event) => event.type === 'full_suite' && event.id === 'K2' && 'passed' in event),
    ).toBeUndefined();
    expect(events.find((event) => event.type === 'workflow_complete')).toMatchObject({
      review: 'passed',
    });

    expect(calls.map((call) => call.kind)).toEqual(['plan', 'task-review', 'final-review']);
    for (const review of calls.slice(1)) {
      expect(review.prompt).toContain('T001 check K2: refused');
      expect(review.prompt).toContain('- K2 T001 (refused): npm run lint');
      expect(review.prompt).toContain(`  reason: ${reason}`);
      expect(review.prompt).not.toContain('T001 check K2: fail');
    }
  });

  it.each([
    ['npm run lint', 'runs a package script or binary (npm run)'],
    ['npx --no-install', 'runs npx without a program'],
  ])(
    'sends a plan whose %s check the policy refuses back to the planner, and the corrected run completes',
    async (command, reason) => {
      const { run, state, events, calls } = await runRefusedCheck({
        approve: 'none',
        plan: alphaPlan({ value: command, required: true }),
        repair: alphaPlan({ value: 'node --version', required: true }),
      });

      expect(run.exitCode, `${run.stdout}\n${run.stderr}`).toBe(0);
      expect(state.phase).toBe('complete');
      expect(state.reviewStatus).toBe('passed');
      expect(state.pendingRecovery).toBeUndefined();
      expect(state.tasks[0]?.checkResults).toEqual([
        { id: 'K1', status: 'pass' },
        { id: 'K2', status: 'pass' },
      ]);
      expect(
        events.find((event) => event.type === 'full_suite' && event.status === 'refused'),
      ).toBeUndefined();
      expect(calls.map((call) => call.kind)).toEqual([
        'plan',
        'plan-repair',
        'task-review',
        'final-review',
      ]);
      expect(calls[0]?.prompt).toContain(
        'This run approves no plan, so SPLITBRIEF refuses a `cmd` check that runs a package script (`npm run <script>`)',
      );
      expect(calls[1]?.prompt).toContain(
        `- refused-check-command: Check K2 is refused: \`${command}\` ${reason}.`,
      );
    },
  );
});
