import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { activateSafeCliShimPath } from '#testing/helpers/compatible-cli-shim.js';
import { makePlanProposal, makeTaskSpec } from '#testing/helpers/factories/plan.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { passingVerdict } from '#testing/helpers/typed-planner.js';
import {
  cli,
  createStopContinueFixture,
  type StopContinueFixture,
} from '../helpers/stop-continue-fixture.js';

const TOTAL_FILE = 'src/total.mjs';
const TOTAL_TEST_FILE = 'src/total.test.mjs';
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
  gate: ['node --version'],
  criteria: [{ id: 'C1', text: 'total returns the sum.', checkIds: ['T001-K1'] }],
  tasks: [brief],
});
/** One verdict answers both reviews: the task review and the final review list the same ids. */
const verdict = passingVerdict({ kind: 'final', taskIds: [brief.id], criterionIds: ['C1'] });

type Call = { kind: string; prompt?: string };

let fixture: StopContinueFixture | undefined;
let restorePath: (() => void) | undefined;
let reviewPrompts: { task: string; final: string };

afterAll(() => {
  restorePath?.();
  vi.unstubAllEnvs();
  if (fixture !== undefined) cleanupTempDir(fixture.tmpDir);
});

/** Runs one brief with a task review and a final review; the fake planner records each prompt it reads on stdin. */
beforeAll(async () => {
  fixture = createStopContinueFixture(() => '');
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
  writeFileSync(
    plannerPath,
    `import { appendFileSync } from 'node:fs';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString('utf8');
let call;
let answer;
if (prompt.includes('# Task Implementation Review') || prompt.includes('# Final Implementation Review')) {
  call = { kind: prompt.includes('# Task Implementation Review') ? 'task-review' : 'final-review', prompt };
  answer = ${JSON.stringify(verdict)};
} else if (prompt.includes('# Plan the change')) {
  call = { kind: 'plan' };
  answer = ${JSON.stringify({ result: plan })};
} else {
  throw new Error('Unexpected prompt: ' + prompt);
}
appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(call) + '\\n');
process.stdout.write(JSON.stringify(answer));
`,
  );
  writeFileSync(
    implementerPath,
    `import { mkdirSync, writeFileSync } from 'node:fs';
for await (const chunk of process.stdin) void chunk;
mkdirSync('src', { recursive: true });
writeFileSync(${JSON.stringify(TOTAL_FILE)}, 'export const total = (a, b) => a + b;\\n');
writeFileSync(${JSON.stringify(TOTAL_TEST_FILE)}, "import { strict as assert } from 'node:assert';\\nimport { total } from './total.mjs';\\nassert.equal(total(1, 2), 3);\\n");
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
    workflow: { ...config.workflow, review: 'task', approve: 'none' },
    validation: { ...config.validation, testCommand: 'node --test', endChecks: true },
  });

  const run = await cli(target, ['start', 'total'], { timeoutMs: 150_000 });
  expect(run.exitCode, `${run.stdout}\n${run.stderr}`).toBe(0);
  const calls: Call[] = readFileSync(callsPath, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  expect(calls.map((call) => call.kind)).toEqual(['plan', 'task-review', 'final-review']);
  reviewPrompts = {
    task: calls[1]?.prompt ?? '',
    final: calls[2]?.prompt ?? '',
  };
}, 300_000);

describe('e2e: the review prompt rules reach the reviewer seat', () => {
  it('tells the task and the final reviewer not to restate a red pending input', () => {
    for (const prompt of [reviewPrompts.task, reviewPrompts.final]) {
      expect(prompt).toContain(
        'A red pending input already blocks the review: do not restate it as a new finding.',
      );
      expect(prompt).toContain(
        "When a failed criterion or a task not met needs a finding for that input, give the input's id to one such finding only.",
      );
      expect(prompt).toContain("A blocking finding under a pending input's id follows this rule.");
    }
  });

  it('tells the task and the final reviewer to keep the id of a finding a fix cycle left open', () => {
    for (const prompt of [reviewPrompts.task, reviewPrompts.final]) {
      expect(prompt).toContain(
        'A finding a fix cycle left open keeps its id, and a new finding never takes an id the triage log names.',
      );
    }
  });

  it('does not tell the task reviewer that the project gate ran', () => {
    expect(reviewPrompts.task).toContain('# Task Implementation Review');
    expect(reviewPrompts.task).toContain('A task review runs no project gate');
    expect(reviewPrompts.task).not.toContain('the Reviewer checks section');
  });
});
