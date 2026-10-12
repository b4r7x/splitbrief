import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
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
    validation: { ...config.validation, testCommand: 'node --test' },
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
  return { run, state: readState(target, sessionId), events: replay.events, calls };
}

describe('e2e: a refused plan check', () => {
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

  it('sends a plan whose check the policy refuses back to the planner, and the corrected run completes', async () => {
    const { run, state, events, calls } = await runRefusedCheck({
      approve: 'none',
      plan: alphaPlan({ value: 'npm run lint', required: true }),
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
      '- refused-check-command: Check K2 is refused: `npm run lint` runs a package script or binary.',
    );
  });
});
