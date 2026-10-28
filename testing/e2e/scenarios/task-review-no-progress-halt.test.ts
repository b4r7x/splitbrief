import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { sessionsRoot } from '../../../src/core/paths.js';
import { formatRecoveryHeadline } from '../../../src/core/recovery/headline.js';
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

const alpha = makeTaskSpec({
  id: 'T001',
  title: 'Add the alpha value',
  intent: 'Return the alpha value.',
  criteria: ['C1'],
  suggestedFiles: ['src/alpha.mjs', 'src/alpha.test.mjs'],
  checks: [{ id: 'T001-K1', kind: 'test', value: 'src/alpha.test.mjs', required: true }],
});
const fixes = ['T002', 'T003', 'T004'].map((id) =>
  makeTaskSpec({
    id,
    title: `Test the alpha value again ${id}`,
    intent: 'Verify that the alpha value is a string.',
    criteria: ['C1'],
    suggestedFiles: [`src/alpha-${id}.test.mjs`],
    contextFiles: ['src/alpha.mjs'],
    checks: [{ id: `${id}-K1`, kind: 'test', value: `src/alpha-${id}.test.mjs`, required: true }],
  }),
);
const plan = makePlanProposal({
  summary: 'Add one tested value.',
  decisions: [],
  criteria: [{ id: 'C1', text: 'Alpha is the string alpha.', checkIds: ['T001-K1'] }],
  tasks: [alpha],
});
const finding = {
  id: 'F1',
  kind: 'defect',
  severity: 'blocking',
  taskId: alpha.id,
  criterionId: null,
  file: 'src/alpha.mjs',
  line: null,
  text: 'The alpha value has no explicit type test.',
  acceptance: 'Add a string type assertion.',
  checkIds: null,
};
const DIAGNOSIS = 'The type test never reaches the alpha value.';
const testSource = (actual: string, expected: string): string =>
  `import { strict as assert } from 'node:assert';\nimport { alpha } from './alpha.mjs';\nassert.equal(${actual}, ${expected});\n`;
const writes = {
  [alpha.title]: {
    'src/alpha.mjs': "export const alpha = 'alpha';\n",
    'src/alpha.test.mjs': testSource('alpha', "'alpha'"),
  },
  ...Object.fromEntries(
    fixes.map((fix) => [
      fix.title,
      { [`src/alpha-${fix.id}.test.mjs`]: testSource('typeof alpha', "'string'") },
    ]),
  ),
};

let fixture: StopContinueFixture | undefined;
let restorePath: (() => void) | undefined;

afterEach(() => {
  restorePath?.();
  vi.unstubAllEnvs();
  if (fixture !== undefined) cleanupTempDir(fixture.tmpDir);
  fixture = undefined;
  restorePath = undefined;
});

describe('e2e: a task review halt', () => {
  it('names the task review that failed, not the final review', async () => {
    fixture = createStopContinueFixture(() => '', { isolation: 'none' });
    const target = fixture;
    restorePath = activateSafeCliShimPath(target.tmpDir);
    const reviewsPath = join(target.tmpDir, 'task-reviews');
    const plannerPath = join(target.tmpDir, 'planner.mjs');
    const implementerPath = join(target.tmpDir, 'implementer.mjs');
    const offlinePath = join(target.tmpDir, 'offline.mjs');
    writeFileSync(
      offlinePath,
      "globalThis.fetch = async () => { throw new Error('E2E network disabled'); };\n",
    );
    vi.stubEnv('NODE_OPTIONS', `--import=${offlinePath}`);
    // Every task review fails on F1 with a new fix brief; the first starts a fix cycle, the second
    // finds F1 still open and asks the planner, whose guidance goes with the next fix brief; the
    // third finds F1 open after the planner's round and halts.
    writeFileSync(
      plannerPath,
      `import { appendFileSync, existsSync, readFileSync } from 'node:fs';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString('utf8');
let answer;
if (prompt.includes('# Task Implementation Review')) {
  const ids = (label) => prompt.match(new RegExp('^' + label + ' (.+)$', 'm'))[1].split(',').map((id) => id.trim());
  const seen = existsSync(${JSON.stringify(reviewsPath)})
    ? readFileSync(${JSON.stringify(reviewsPath)}, 'utf8').length
    : 0;
  appendFileSync(${JSON.stringify(reviewsPath)}, 'r');
  const fix = ${JSON.stringify(fixes)}[seen];
  answer = {
    ...${JSON.stringify(passingVerdict({ kind: 'task', taskIds: [], criterionIds: [] }))},
    tasks: ids('Task ids:').map((id) => ({ id, plan: 'met', note: '' })),
    criteria: ids('Criterion ids:').map((id) => ({ id, status: 'pass', evidence: '' })),
    findings: [${JSON.stringify(finding)}],
    fixTasks: [{ ...fix, findingIds: ['F1'] }],
  };
} else if (/^# Consult on a failing task$/m.test(prompt)) {
  answer = {
    answer: {
      diagnosis: ${JSON.stringify(DIAGNOSIS)},
      action: 'guidance',
      instructions: 'Import alpha in the type test.',
      context: null,
    },
  };
} else if (prompt.includes('# Plan the change')) {
  answer = ${JSON.stringify({ result: plan })};
} else {
  throw new Error('Unexpected prompt: ' + prompt);
}
process.stdout.write(JSON.stringify(answer));
`,
    );
    writeFileSync(
      implementerPath,
      `import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString('utf8');
const title = prompt.match(/^## Task: (.+)$/m)?.[1];
const files = ${JSON.stringify(writes)}[title];
if (!files) throw new Error('Unexpected brief: ' + prompt);
for (const [file, source] of Object.entries(files)) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, source);
}
console.log('Implemented ' + title);
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
      validation: { ...config.validation, testCommand: 'node --test' },
    });

    const run = await cli(target, ['start', 'smoke']);
    expect(run.exitCode, `${run.stdout}\n${run.stderr}`).not.toBe(0);
    expect(run.stderr).toContain(
      'Needs you (review-failed): Review T003 made no progress on F1 after fix cycle 2',
    );
    expect(run.stderr).not.toContain('Final review');

    const [sessionId] = readdirSync(sessionsRoot(target.projectDir));
    if (sessionId === undefined) throw new Error('Missing session');
    const { events } = await readRunEvents({ projectDir: target.projectDir, sessionId });
    expect(
      events
        .filter((event) => event.type === 'review_completed')
        .map((event) => [event.scope, event.afterTaskId, event.verdict]),
    ).toEqual([
      ['task', 'T001', 'fail'],
      ['task', 'T002', 'fail'],
      ['task', 'T003', 'fail'],
    ]);
    expect(events.filter((event) => event.type === 'error').map((event) => event.message)).toEqual([
      'Review T003 made no progress on F1 after fix cycle 2; see review.md',
    ]);
    expect(
      events.filter((event) => event.type === 'recovery_prompted').map((event) => event.headline),
    ).toEqual(['Review T003 made no progress on F1 after fix cycle 2']);

    const state = readState(target, sessionId);
    expect(state.phase).toBe('implementing');
    expect(state.pendingRecovery).toMatchObject({
      reason: 'review-failed',
      message: 'Review T003 made no progress on F1 after fix cycle 2',
      availableActions: ['revise', 'end-run'],
      details: [`Planner: ${DIAGNOSIS}`, `Reviewer: F1: ${finding.text}`],
    });
    if (state.pendingRecovery === undefined) throw new Error('Missing halt');
    expect(formatRecoveryHeadline(state.pendingRecovery)).toBe(
      'Review T003 made no progress on F1 after fix cycle 2',
    );
  });

  it('names the task review that reached no verdict, not the final review', async () => {
    fixture = createStopContinueFixture(() => '', { isolation: 'none' });
    const target = fixture;
    restorePath = activateSafeCliShimPath(target.tmpDir);
    const plannerPath = join(target.tmpDir, 'planner.mjs');
    const implementerPath = join(target.tmpDir, 'implementer.mjs');
    const offlinePath = join(target.tmpDir, 'offline.mjs');
    writeFileSync(
      offlinePath,
      "globalThis.fetch = async () => { throw new Error('E2E network disabled'); };\n",
    );
    vi.stubEnv('NODE_OPTIONS', `--import=${offlinePath}`);
    // The reviewer process crashes on the task review of T001.
    writeFileSync(
      plannerPath,
      `const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString('utf8');
if (prompt.includes('# Task Implementation Review')) {
  process.stderr.write('reviewer crashed\\n');
  process.exit(1);
}
if (!prompt.includes('# Plan the change')) throw new Error('Unexpected prompt: ' + prompt);
process.stdout.write(JSON.stringify(${JSON.stringify({ result: plan })}));
`,
    );
    writeFileSync(
      implementerPath,
      `import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
const files = ${JSON.stringify(writes[alpha.title])};
for (const [file, source] of Object.entries(files)) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, source);
}
console.log('Implemented the alpha value');
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
      validation: { ...config.validation, testCommand: 'node --test' },
    });

    const run = await cli(target, ['start', 'smoke']);
    expect(run.exitCode, `${run.stdout}\n${run.stderr}`).not.toBe(0);
    expect(run.stderr).toContain('Needs you (review-failed): Review T001 failed: ');
    expect(run.stderr).not.toContain('Final review');

    const [sessionId] = readdirSync(sessionsRoot(target.projectDir));
    if (sessionId === undefined) throw new Error('Missing session');
    const { events } = await readRunEvents({ projectDir: target.projectDir, sessionId });
    expect(
      events.filter((event) => event.type === 'recovery_prompted').map((event) => event.headline),
    ).toEqual(['Review T001 reached no verdict']);
    const errors = events.flatMap((event) => (event.type === 'error' ? [event.message] : []));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^Review T001 failed: /);

    const state = readState(target, sessionId);
    expect(state.phase).toBe('implementing');
    expect(state.pendingRecovery).toMatchObject({
      reason: 'review-failed',
      availableActions: ['retry-same-worker', 'end-run'],
    });
  });
});
