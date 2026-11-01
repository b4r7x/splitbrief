import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { sessionsRoot } from '../../../src/core/paths.js';
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

const plan = makePlanProposal({
  summary: 'Add a tested alpha value.',
  decisions: [],
  criteria: [{ id: 'C1', text: 'Alpha is the string alpha.', checkIds: ['K1'] }],
  tasks: [
    makeTaskSpec({
      id: 'T001',
      title: 'Add the alpha value',
      intent: 'Return the alpha value.',
      criteria: ['C1'],
      suggestedFiles: ['src/alpha.mjs', 'src/alpha.test.mjs'],
      checks: [{ id: 'K1', kind: 'test', value: 'src/alpha.test.mjs', required: true }],
    }),
  ],
});

function gate(count: number): string[] {
  return Array.from({ length: count }, () => 'node --version');
}

/** The planner answers its first plan turn with `gateSize` gate commands, and a later plan turn with six. */
async function runPlanGate(gateSize: number) {
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
    `import { appendFileSync, existsSync } from 'node:fs';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString('utf8');
let kind;
let answer;
if (prompt.includes('# Task Implementation Review') || prompt.includes('# Final Implementation Review')) {
  kind = 'review';
  answer = ${JSON.stringify(passing)};
} else if (!existsSync(${JSON.stringify(callsPath)})) {
  kind = 'plan';
  answer = ${JSON.stringify({ result: { ...plan, gate: gate(gateSize) } })};
} else {
  kind = 'plan-again';
  answer = ${JSON.stringify({ result: { ...plan, gate: gate(6) } })};
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
    workflow: { ...config.workflow, review: 'end', approve: 'none' },
    validation: { ...config.validation, testCommand: 'node --test', endChecks: true },
  });
  const run = await cli(target, ['start', 'smoke']);
  const sessions = readdirSync(sessionsRoot(target.projectDir));
  expect(sessions).toHaveLength(1);
  const sessionId = sessions[0];
  if (sessionId === undefined) throw new Error('Missing session');
  const calls: Array<{ kind: string; prompt: string }> = existsSync(callsPath)
    ? readFileSync(callsPath, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
    : [];
  return { run, state: readState(target, sessionId), calls };
}

describe('e2e: the project gate the plan names', () => {
  it('sends a plan with seven gate commands back to the planner and runs only the six of the next plan', async () => {
    const { run, state, calls } = await runPlanGate(7);

    expect(run.exitCode, `${run.stdout}\n${run.stderr}`).toBe(0);
    expect(run.stderr).toContain(
      'The planner seat answer did not match its contract. Wrong or missing value in gate. Asking the seat again.',
    );
    expect(calls.map((call) => call.kind)).toEqual(['plan', 'plan-again', 'review']);
    expect(calls[1]?.prompt).toContain('result.gate: Too big: expected array to have <=6 items');
    expect(state.phase).toBe('complete');
    expect(run.stdout).toContain('reviewer check V6: passed');
    expect(run.stdout).not.toContain('V7');
  });

  it('runs a plan with six gate commands as the planner sent it', async () => {
    const { run, state, calls } = await runPlanGate(6);

    expect(run.exitCode, `${run.stdout}\n${run.stderr}`).toBe(0);
    expect(run.stderr).not.toContain('did not match its contract');
    expect(calls.map((call) => call.kind)).toEqual(['plan', 'review']);
    expect(state.phase).toBe('complete');
    expect(run.stdout).toContain('reviewer check V6: passed');
  });

  it('tells the planner and the final reviewer that SPLITBRIEF runs the project gate the plan names', async () => {
    const { calls } = await runPlanGate(6);
    const planPrompt = calls.find((call) => call.kind === 'plan')?.prompt;
    const reviewPrompt = calls.find((call) => call.kind === 'review')?.prompt;

    expect
      .soft(planPrompt)
      .toContain(
        'and SPLITBRIEF runs the checks itself, and the project gate before the final review.',
      );
    expect(reviewPrompt).toContain('# Final Implementation Review');
    expect
      .soft(reviewPrompt)
      .toContain(
        "The Checks Log section and the Reviewer checks section carry the run's command output: the checks of the plan and the tasks, and the project gate the plan names.",
      );
  });
});
