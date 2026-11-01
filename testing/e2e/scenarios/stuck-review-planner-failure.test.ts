import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { sessionsRoot } from '../../../src/core/paths.js';
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

describe('e2e: a planner call that fails on a stuck review', () => {
  it.each([
    [
      'crash',
      'planner-call-failed',
      'Seat down (planner-call-failed): Planner call on the stuck review failed: node exited with code 1: The planner process stopped unexpectedly.',
    ],
    [
      'broken',
      'seat-protocol-error',
      'Seat down (seat-protocol-error): The planner seat answer did not match its contract after 2 attempts.',
    ],
  ] as const)(
    'halts on the PLAN seat when the planner answer is %s on the stuck review',
    async (mode, reason, headline) => {
      fixture = createStopContinueFixture(() => '', { isolation: 'none' });
      const target = fixture;
      restorePath = activateSafeCliShimPath(target.tmpDir);
      const reviewsPath = join(target.tmpDir, 'task-reviews');
      const consultsPath = join(target.tmpDir, 'consults');
      const callsPath = join(target.tmpDir, 'planner-calls');
      const recoveredPath = join(target.tmpDir, 'planner-recovered');
      const plannerPath = join(target.tmpDir, 'planner.mjs');
      const implementerPath = join(target.tmpDir, 'implementer.mjs');
      const offlinePath = join(target.tmpDir, 'offline.mjs');
      writeFileSync(
        offlinePath,
        "globalThis.fetch = async () => { throw new Error('E2E network disabled'); };\n",
      );
      vi.stubEnv('NODE_OPTIONS', `--import=${offlinePath}`);
      // Every task review fails on F1 with a new fix brief. The second review finds F1 still open
      // after fix cycle 1 and asks the planner; the planner process crashes, or answers {}.
      writeFileSync(
        plannerPath,
        `import { appendFileSync, existsSync, readFileSync } from 'node:fs';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString('utf8');
const recovered = existsSync(${JSON.stringify(recoveredPath)});
let answer;
if (prompt.includes('# Final Implementation Review')) {
  appendFileSync(${JSON.stringify(callsPath)}, 'final\\n');
  answer = ${JSON.stringify(passingVerdict({ kind: 'final', taskIds: ['T001', 'T002', 'T003'], criterionIds: ['C1'] }))};
} else if (prompt.includes('# Task Implementation Review')) {
  appendFileSync(${JSON.stringify(callsPath)}, 'review\\n');
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
    findings: recovered ? [] : [${JSON.stringify(finding)}],
    fixTasks: recovered ? [] : [{ ...fix, findingIds: ['F1'] }],
  };
} else if (/^# Consult on a failing task$/m.test(prompt)) {
  appendFileSync(${JSON.stringify(callsPath)}, 'consult\\n');
  appendFileSync(${JSON.stringify(consultsPath)}, prompt.includes('Blockers that did not move:') ? 's' : 'o');
  if (recovered) {
    answer = {
      answer: {
        diagnosis: 'The fix tests the value again.',
        action: 'guidance',
        instructions: 'Test the type of the value.',
        context: null,
      },
    };
  } else if (${JSON.stringify(mode)} === 'crash') {
    process.stderr.write('The planner process stopped unexpectedly.\\n');
    process.exit(1);
  } else {
    answer = {};
  }
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
      const [sessionId] = readdirSync(sessionsRoot(target.projectDir));
      if (sessionId === undefined) throw new Error('Missing session');
      const { events } = await readRunEvents({ projectDir: target.projectDir, sessionId });
      const state = readState(target, sessionId);
      expect(run.exitCode, `${run.stdout}\n${run.stderr}`).not.toBe(0);
      expect(run.stderr).toContain(headline);
      expect(run.stderr).not.toContain('Workflow failed');
      expect(readFileSync(consultsPath, 'utf8')).toMatch(/^s+$/);
      expect(
        events
          .filter((event) => event.type === 'review_completed')
          .map((event) => [event.scope, event.afterTaskId, event.verdict]),
      ).toEqual([
        ['task', 'T001', 'fail'],
        ['task', 'T002', 'fail'],
      ]);
      expect(state.pendingRecovery).toMatchObject({ reason, seat: 'plan' });
      expect(state.pendingRecovery?.availableActions).toContain('retry-same-worker');
      expect(state.pendingRecovery?.availableActions).not.toContain('accept-as-is');
      expect(state.tasks.map((task) => task.id)).toEqual(['T001', 'T002']);

      const halted = readFileSync(callsPath, 'utf8');
      writeFileSync(recoveredPath, '');
      const retried = await cli(target, ['continue', sessionId, '--action', 'retry']);
      expect(retried.exitCode, `${retried.stdout}\n${retried.stderr}`).toBe(0);
      expect(readFileSync(callsPath, 'utf8').slice(halted.length)).toBe('consult\nreview\nfinal\n');
    },
  );
});
