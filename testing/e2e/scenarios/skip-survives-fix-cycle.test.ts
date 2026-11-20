import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { sessionsRoot } from '../../../src/core/paths.js';
import type { ReviewAnswer } from '../../../src/core/schemas/review/verdict.js';
import { readRunRecord } from '../../../src/core/sessions/run/record-io.js';
import { readRunEvents } from '../../../src/engine/events/replay.js';
import { briefRowParts } from '../../../src/features/workflow/closed/copy/stage-facts.js';
import { deriveSummaryView } from '../../../src/features/workflow/closed/view-model.js';
import { activateSafeCliShimPath } from '#testing/helpers/compatible-cli-shim.js';
import { makePlanProposal, makeTaskSpec } from '#testing/helpers/factories/plan.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import {
  cli,
  createStopContinueFixture,
  readState,
  type StopContinueFixture,
} from '../helpers/stop-continue-fixture.js';

const ALPHA_FILE = 'src/alpha.mjs';
const BETA_FILE = 'src/beta.mjs';
const alpha = makeTaskSpec({
  id: 'T001',
  title: 'Add the alpha value',
  intent: 'Return the alpha value.',
  criteria: ['C1'],
  suggestedFiles: [ALPHA_FILE],
  checks: [{ id: 'T001-K1', kind: 'test', value: ALPHA_FILE }],
});
const plan = makePlanProposal({
  summary: 'Add two values.',
  decisions: [],
  criteria: [
    { id: 'C1', text: 'Alpha is the string alpha.', checkIds: ['T001-K1'] },
    { id: 'C2', text: 'Beta is the string beta.', checkIds: ['T002-K1'] },
  ],
  tasks: [
    alpha,
    makeTaskSpec({
      id: 'T002',
      title: 'Add the beta value',
      intent: 'Return the beta value.',
      criteria: ['C2'],
      suggestedFiles: [BETA_FILE],
      checks: [{ id: 'T002-K1', kind: 'test', value: BETA_FILE }],
    }),
  ],
});
const fix = makeTaskSpec({
  id: 'T003',
  title: 'Create the alpha module',
  intent: 'Create the alpha module the review found missing.',
  criteria: [],
  suggestedFiles: [ALPHA_FILE],
  checks: [{ id: 'T003-K1', kind: 'test', value: ALPHA_FILE }],
});
const finding: ReviewAnswer['findings'][number] = {
  id: 'F1',
  kind: 'defect',
  severity: 'blocking',
  taskId: null,
  criterionId: null,
  file: ALPHA_FILE,
  line: null,
  text: 'src/alpha.mjs is missing.',
  acceptance: null,
  checkIds: null,
};

let fixture: StopContinueFixture | undefined;
let restorePath: (() => void) | undefined;

beforeEach(() => resetAllStores());

afterEach(() => {
  resetAllStores();
  restorePath?.();
  vi.unstubAllEnvs();
  if (fixture !== undefined) cleanupTempDir(fixture.tmpDir);
  fixture = undefined;
  restorePath = undefined;
});

/**
 * A run whose implementer reports T001 blocked and whose planner crashes on the consult, so
 * T001 halts. The independent T002 builds after Skip. The first final review then asks for one fix.
 */
async function haltOnFailedConsult() {
  fixture = createStopContinueFixture(() => '');
  const target = fixture;
  restorePath = activateSafeCliShimPath(target.tmpDir);
  const offlinePath = join(target.tmpDir, 'offline.mjs');
  writeFileSync(
    offlinePath,
    "globalThis.fetch = async () => { throw new Error('E2E network disabled'); };\n",
  );
  vi.stubEnv('NODE_OPTIONS', `--import=${offlinePath}`);
  const plannerPath = join(target.tmpDir, 'planner.mjs');
  const implementerPath = join(target.tmpDir, 'implementer.mjs');
  const reviewsPath = join(target.tmpDir, 'reviews.log');
  const callsPath = join(target.tmpDir, 'calls.log');
  writeFileSync(
    plannerPath,
    `import { appendFileSync, existsSync, readFileSync } from 'node:fs';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString('utf8');
const ids = (label) => {
  const value = prompt.match(new RegExp('^' + label + ' (.+)$', 'm'))?.[1].trim() ?? 'none';
  return value === 'none' ? [] : value.split(',').map((id) => id.trim());
};
const heading = prompt.split('\\n').find((line) => line.startsWith('# '));
let answer;
if (prompt.includes('# Final Implementation Review')) {
  const reviews = existsSync(${JSON.stringify(reviewsPath)})
    ? readFileSync(${JSON.stringify(reviewsPath)}, 'utf8').length
    : 0;
  appendFileSync(${JSON.stringify(reviewsPath)}, 'r');
  answer = {
    tasks: ids('Task ids:').map((id) => ({ id, plan: 'met', note: '' })),
    criteria: ids('Criterion ids:').map((id) => ({ id, status: 'pass', evidence: '' })),
    findings: reviews === 0 ? [${JSON.stringify(finding)}] : [],
    fixTasks: reviews === 0 ? [{ ...${JSON.stringify(fix)}, findingIds: ['F1'] }] : [],
    rejected: [],
    ask: null,
  };
} else if (heading === '# Consult on a failing task') {
  process.stderr.write('The planner process crashed.\\n');
  process.exit(1);
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
    `import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
for await (const _chunk of process.stdin);
const calls = existsSync(${JSON.stringify(callsPath)})
  ? readFileSync(${JSON.stringify(callsPath)}, 'utf8').length
  : 0;
appendFileSync(${JSON.stringify(callsPath)}, 'c');
const value = calls === 1 ? 'beta' : 'alpha';
const file = calls === 1 ? ${JSON.stringify(BETA_FILE)} : ${JSON.stringify(ALPHA_FILE)};
mkdirSync('src', { recursive: true });
writeFileSync(file, 'export const ' + value + ' = ' + JSON.stringify(value) + ';\\n');
console.log(JSON.stringify(calls === 0
  ? { status: 'blocked', question: 'Which module should export alpha?', filesNeeded: [] }
  : {
      status: 'done',
      filesChanged: [file],
      touchedNotSuggested: [],
      notes: null,
      decisions: [],
    }));
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
  });
  const halted = await cli(target, ['start', 'smoke']);
  expect(halted.exitCode, `${halted.stdout}\n${halted.stderr}`).toBe(1);
  const [sessionId] = readdirSync(sessionsRoot(target.projectDir));
  if (sessionId === undefined) throw new Error('Missing session');
  return { target, sessionId };
}

describe('e2e: a skipped brief through a review fix cycle', { timeout: 240_000 }, () => {
  it('builds the independent and fix briefs, and the closed Briefs block keeps the skipped brief skipped', async () => {
    const { target, sessionId } = await haltOnFailedConsult();
    expect(readState(target, sessionId).pendingRecovery).toMatchObject({
      reason: 'planner-call-failed',
      taskId: 'T001',
    });

    const skipped = await cli(target, ['continue', sessionId, '--plain', '--action', 'skip']);

    expect(skipped.exitCode, `${skipped.stdout}\n${skipped.stderr}`).toBe(0);
    const ref = { projectDir: target.projectDir, sessionId };
    const { events } = await readRunEvents(ref);
    expect(events.find((event) => event.type === 'review_fix_started')).toMatchObject({
      taskIds: ['T003'],
    });
    const starts = events.flatMap((event) => (event.type === 'task_started' ? [event.taskId] : []));
    expect(starts).toEqual(['T001', 'T002', 'T003']);
    expect(readState(target, sessionId).tasks.map((task) => [task.id, task.status])).toEqual([
      ['T001', 'skipped'],
      ['T002', 'done'],
      ['T003', 'done'],
    ]);
    const applied = await cli(target, ['continue', sessionId, '--action', 'apply']);
    expect(applied.exitCode, `${applied.stdout}\n${applied.stderr}`).toBe(0);
    const view = deriveSummaryView({ record: readRunRecord(ref, false) });
    if (view === null) throw new Error('the finished run has no closed view');
    expect(view.briefs.rows.map((row) => briefRowParts({ row }))).toMatchObject([
      { id: 'T001', state: { kind: 'settled', method: 'skipped' } },
      { id: 'T002', state: { kind: 'settled', method: 'local' } },
      { id: 'T003', state: { kind: 'settled', method: 'local' } },
    ]);
  });
});
