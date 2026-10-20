import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { sessionsRoot } from '../../../src/core/paths.js';
import { activateSafeCliShimPath } from '#testing/helpers/compatible-cli-shim.js';
import { makePlanProposal, makeTaskSpec } from '#testing/helpers/factories/plan.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { guidanceConsult, passingVerdict } from '#testing/helpers/typed-planner.js';
import {
  cli,
  createStopContinueFixture,
  readState,
  type StopContinueFixture,
} from '../helpers/stop-continue-fixture.js';

const RUN_TIMEOUT_MS = 150_000;

const alpha = makeTaskSpec({
  id: 'T001',
  title: 'Add the alpha value',
  intent: 'Return the alpha value.',
  criteria: ['C1'],
  suggestedFiles: ['src/alpha.mjs', 'src/alpha.test.mjs'],
  checks: [{ id: 'T001-K1', kind: 'test', value: 'src/alpha.test.mjs', required: true }],
});
const plan = makePlanProposal({
  summary: 'Add one tested value.',
  decisions: [],
  criteria: [{ id: 'C1', text: 'Alpha is the string alpha.', checkIds: ['T001-K1'] }],
  tasks: [alpha],
});
const NOTES = 'docs/Alpha Notes.md';
const notesPlan = {
  ...plan,
  tasks: [{ ...alpha, suggestedFiles: [...alpha.suggestedFiles, NOTES] }],
};
const ALPHA_TEST =
  "import { strict as assert } from 'node:assert';\nimport { alpha } from './alpha.mjs';\nassert.equal(alpha, 'alpha');\n";

let fixture: StopContinueFixture | undefined;
let restorePath: (() => void) | undefined;

afterEach(() => {
  restorePath?.();
  vi.unstubAllEnvs();
  if (fixture !== undefined) cleanupTempDir(fixture.tmpDir);
  fixture = undefined;
  restorePath = undefined;
});

/**
 * The first attempt writes both files with a value check T001-K1 rejects, and `generated` data
 * files outside the brief, and with `notes` a brief file with a space in its path; the local retry
 * changes nothing. The planner logs the consult prompt and answers with guidance, after which the
 * implementer writes the right value.
 */
function writeRunners(
  target: StopContinueFixture,
  callsPath: string,
  { generated = 0, notes = false } = {},
) {
  const plannerPath = join(target.tmpDir, 'planner.mjs');
  const implementerPath = join(target.tmpDir, 'implementer.mjs');
  const passing = passingVerdict({ kind: 'final', taskIds: [alpha.id], criterionIds: ['C1'] });
  writeFileSync(
    plannerPath,
    `import { appendFileSync } from 'node:fs';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString('utf8');
let answer;
if (prompt.includes('# Final Implementation Review') || prompt.includes('# Task Implementation Review')) {
  answer = ${JSON.stringify(passing)};
} else if (prompt.includes('# Consult on a failing task') || prompt.includes('# Consult continued')) {
  appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ kind: 'consult', prompt }) + '\\n');
  answer = ${JSON.stringify(guidanceConsult('Set alpha to the string alpha.'))};
} else if (prompt.includes('# Plan the change')) {
  answer = ${JSON.stringify({ result: notes ? notesPlan : plan })};
} else {
  throw new Error('Unexpected prompt: ' + prompt);
}
process.stdout.write(JSON.stringify(answer));
`,
  );
  writeFileSync(
    implementerPath,
    `import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
const calls = readFileSync(${JSON.stringify(callsPath)}, 'utf8').split('\\n').filter(Boolean);
const attempt = calls.filter((line) => line.includes('"kind":"implement"')).length;
const consulted = calls.some((line) => line.includes('"kind":"consult"'));
appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ kind: 'implement', attempt }) + '\\n');
if (attempt === 0 && ${generated} > 0) {
  mkdirSync('data', { recursive: true });
  for (let index = 0; index < ${generated}; index += 1) {
    writeFileSync('data/gen-' + String(index).padStart(3, '0') + '.txt', 'GENERATED-ROW\\n' + 'x'.repeat(1000) + '\\n');
  }
}
if (attempt === 0 && ${notes}) {
  mkdirSync('docs', { recursive: true });
  writeFileSync(${JSON.stringify(NOTES)}, 'NOTES-BODY\\n');
}
if (attempt === 0 || consulted) {
  mkdirSync('src', { recursive: true });
  const value = consulted ? 'alpha' : 'not alpha';
  writeFileSync('src/alpha.mjs', 'export const alpha = ' + JSON.stringify(value) + ';\\n');
  writeFileSync('src/alpha.test.mjs', ${JSON.stringify(ALPHA_TEST)});
}
console.log('Implemented T001');
`,
  );
  writeFileSync(callsPath, '');
  const config = loadConfig(target.projectDir).config;
  if (config.planner.kind !== 'shell' || config.implementer.kind !== 'agent') {
    throw new Error('Expected local shell and agent fixture runners');
  }
  writeConfig(target.projectDir, {
    ...config,
    planner: { ...config.planner, args: [plannerPath] },
    implementer: { ...config.implementer, args: [implementerPath] },
    validation: { ...config.validation, testCommand: 'node --test' },
    workflow: { ...config.workflow, review: 'task', approve: 'none' },
  });
}

function consultPrompts(callsPath: string): string[] {
  return readFileSync(callsPath, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { kind: string; prompt?: string })
    .filter((call) => call.kind === 'consult')
    .map((call) => call.prompt ?? '');
}

describe('e2e: the consult after two failed attempts', { timeout: 360_000 }, () => {
  it("shows the first attempt's files and one line per failed attempt", async () => {
    fixture = createStopContinueFixture(() => '', { isolation: 'none' });
    const target = fixture;
    restorePath = activateSafeCliShimPath(target.tmpDir);
    const offlinePath = join(target.tmpDir, 'offline.mjs');
    writeFileSync(
      offlinePath,
      "globalThis.fetch = async () => { throw new Error('E2E network disabled'); };\n",
    );
    vi.stubEnv('NODE_OPTIONS', `--import=${offlinePath}`);
    const callsPath = join(target.tmpDir, 'calls.jsonl');
    writeRunners(target, callsPath);

    const run = await cli(target, ['start', 'smoke'], { timeoutMs: RUN_TIMEOUT_MS });
    expect(run.exitCode, `${run.stdout}\n${run.stderr}`).toBe(0);

    const prompts = consultPrompts(callsPath);
    expect(prompts).toHaveLength(1);
    const prompt = prompts[0] ?? '';
    expect(prompt).toContain('## Task Diff');
    expect(prompt).toContain('## Failed Attempts');
    const taskDiff = prompt.slice(
      prompt.indexOf('## Task Diff'),
      prompt.indexOf('## Failed Attempts'),
    );
    expect(taskDiff).toContain('src/alpha.mjs');
    expect(taskDiff).toContain('+export const alpha = "not alpha";');
    expect(taskDiff).toContain('src/alpha.test.mjs');
    expect(prompt).toMatch(/^- Attempt 1 \(T001 revision 1\): check T001-K1 did not pass/m);
    expect(prompt).toMatch(
      /^- Attempt 2 \(T001 revision 1\): .*exited without changing any files/m,
    );
    expect(prompt.indexOf('## Failed Attempts')).toBeLessThan(prompt.indexOf('## Failing Output'));

    const sessionId = readdirSync(sessionsRoot(target.projectDir))[0];
    if (sessionId === undefined) throw new Error('Missing session');
    const state = readState(target, sessionId);
    expect(state.phase).toBe('complete');
    expect(state.lineages?.T001?.startSnapshot).toBeUndefined();
  });

  it('shows the diff of the brief files behind many generated files and names those', async () => {
    fixture = createStopContinueFixture(() => '', { isolation: 'none' });
    const target = fixture;
    restorePath = activateSafeCliShimPath(target.tmpDir);
    const offlinePath = join(target.tmpDir, 'offline.mjs');
    writeFileSync(
      offlinePath,
      "globalThis.fetch = async () => { throw new Error('E2E network disabled'); };\n",
    );
    vi.stubEnv('NODE_OPTIONS', `--import=${offlinePath}`);
    const callsPath = join(target.tmpDir, 'calls.jsonl');
    writeRunners(target, callsPath, { generated: 60 });

    const run = await cli(target, ['start', 'smoke'], { timeoutMs: RUN_TIMEOUT_MS });
    expect(run.exitCode, `${run.stdout}\n${run.stderr}`).toBe(0);

    const prompts = consultPrompts(callsPath);
    expect(prompts).toHaveLength(1);
    const prompt = prompts[0] ?? '';
    const taskDiff = prompt.slice(
      prompt.indexOf('## Task Diff'),
      prompt.indexOf('## Failed Attempts'),
    );
    expect(taskDiff).toContain('+export const alpha = "not alpha";');
    expect(taskDiff).not.toContain('GENERATED-ROW');
    expect(taskDiff).not.toContain('The diff stops');
    expect(taskDiff).toContain(
      'This task also changed other files, not shown here: `data/gen-000.txt`',
    );
    expect(taskDiff).toContain('and 40 more. Read these files in the run workspace.');
  });

  it('shows the diff of a brief file with a space in its path', async () => {
    fixture = createStopContinueFixture(() => '', { isolation: 'none' });
    const target = fixture;
    restorePath = activateSafeCliShimPath(target.tmpDir);
    const offlinePath = join(target.tmpDir, 'offline.mjs');
    writeFileSync(
      offlinePath,
      "globalThis.fetch = async () => { throw new Error('E2E network disabled'); };\n",
    );
    vi.stubEnv('NODE_OPTIONS', `--import=${offlinePath}`);
    const callsPath = join(target.tmpDir, 'calls.jsonl');
    writeRunners(target, callsPath, { notes: true });

    const run = await cli(target, ['start', 'smoke'], { timeoutMs: RUN_TIMEOUT_MS });
    expect(run.exitCode, `${run.stdout}\n${run.stderr}`).toBe(0);

    const prompts = consultPrompts(callsPath);
    expect(prompts).toHaveLength(1);
    const prompt = prompts[0] ?? '';
    const taskDiff = prompt.slice(
      prompt.indexOf('## Task Diff'),
      prompt.indexOf('## Failed Attempts'),
    );
    expect(taskDiff).toContain(NOTES);
    expect(taskDiff).toContain('+NOTES-BODY');
    expect(taskDiff).not.toContain('not shown here');
  });
});
