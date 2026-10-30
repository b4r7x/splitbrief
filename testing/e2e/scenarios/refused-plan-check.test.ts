import { chmodSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { sessionsRoot } from '../../../src/core/paths.js';
import { readRunEvents } from '../../../src/engine/events/replay.js';
import { activateSafeCliShimPath } from '#testing/helpers/compatible-cli-shim.js';
import { makePlanProposal, makeTaskSpec } from '#testing/helpers/factories/plan.js';
import type { PlanProposal } from '../../../src/core/schemas/plan.js';
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
if (prompt.includes('# Task Implementation Review')) {
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
      endChecks: true,
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
  it('sends a plan whose project gate names a refused option back to the planner, and never runs it', async () => {
    const refused = [
      {
        command: 'gradle --init-script setup.gradle test',
        detail: 'uses the code-loading option gradle --init-script',
      },
      { command: 'just --shell node test', detail: 'uses the code-loading option just --shell' },
      {
        command: 'node --require=./setup.js --test',
        detail: 'uses the code-loading option node --require',
      },
    ];
    const plan = alphaPlan({ value: 'node --version', required: true });
    const { run, state, events, calls, executedPath } = await runRefusedCheck({
      approve: 'none',
      plan: { ...plan, gate: refused.map(({ command }) => command) },
      repair: { ...plan, gate: ['node --version'] },
    });

    expect(run.exitCode, `${run.stdout}\n${run.stderr}`).toBe(0);
    expect(state.phase).toBe('complete');
    expect(state.reviewStatus).toBe('passed');
    expect(existsSync(executedPath)).toBe(false);
    expect(calls.map((call) => call.kind)).toEqual([
      'plan',
      'plan-repair',
      'task-review',
      'final-review',
    ]);
    for (const [index, { command, detail }] of refused.entries()) {
      expect(calls[1]?.prompt).toContain(
        `- refused-check-command: Gate command V${index + 1} is refused: \`${command}\` ${detail}.`,
      );
    }
    expect(
      events.find((event) => event.type === 'full_suite' && event.status === 'refused'),
    ).toBeUndefined();
    expect(
      events.filter(
        (event) =>
          event.type === 'full_suite' &&
          event.id === 'V1' &&
          event.moment === 'pre-review' &&
          event.status === 'done',
      ),
    ).toMatchObject([{ command: 'node --version', passed: true, moment: 'pre-review' }]);
    expect(calls[3]?.prompt).toContain('- V1 `node --version`: passed');
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
      `The test checks do not take ${command} from the plan: it ${reason}. They use config, the manifest or the stack default.`,
    ]);
    expect(calls.map((call) => call.kind)).toEqual(['plan', 'task-review', 'final-review']);
    expect(state.tasks[0]?.checkResults).toEqual([
      { id: 'K1', status: 'pass' },
      { id: 'K2', status: 'pass' },
    ]);
  });

  it('sends a plan whose npm run check names a script package.json lacks back to the planner', async () => {
    const { run, state, events, calls } = await runRefusedCheck({
      approve: 'plan',
      plan: alphaPlan({ value: 'npm run lint', required: true }),
      repair: alphaPlan({ value: 'node --version', required: true }),
    });

    expect(run.exitCode, `${run.stdout}\n${run.stderr}`).toBe(0);
    expect(state.phase).toBe('complete');
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
    expect(calls[1]?.prompt).toContain(
      "- refused-check-command: Check K2 is refused: `npm run lint` runs an npm script, but package.json was not found. Name a script that package.json defines, or list package.json in the task's files and add the script there.",
    );
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
