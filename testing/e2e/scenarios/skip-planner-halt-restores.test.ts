import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { sessionsRoot } from '../../../src/core/paths.js';
import { readSessionSummary } from '../../../src/core/sessions/run-record-io.js';
import { readRunEvents } from '../../../src/engine/events/replay.js';
import { activateSafeCliShimPath } from '#testing/helpers/compatible-cli-shim.js';
import { makePlanProposal, makeTaskSpec } from '#testing/helpers/factories/plan.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { passingVerdict } from '#testing/helpers/typed-planner.js';
import {
  cli,
  createStopContinueFixture,
  readState,
  type StopContinueFixture,
} from '../helpers/stop-continue-fixture.js';
import { transcriptText } from '../helpers/transcript-text.js';

const ALPHA_FILE = 'src/alpha.mjs';
const alpha = makeTaskSpec({
  id: 'T001',
  title: 'Add the alpha value',
  intent: 'Return the alpha value.',
  criteria: ['C1'],
  suggestedFiles: [ALPHA_FILE],
  checks: [{ id: 'T001-K1', kind: 'test', value: ALPHA_FILE, required: true }],
});
const plan = makePlanProposal({
  summary: 'Add one value.',
  decisions: [],
  criteria: [{ id: 'C1', text: 'Alpha is the string alpha.', checkIds: ['T001-K1'] }],
  tasks: [alpha],
});
const BETA_FILE = 'src/beta.mjs';
const dependentPlan = makePlanProposal({
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
      dependsOn: [alpha.id],
      suggestedFiles: [BETA_FILE],
      checks: [{ id: 'T002-K1', kind: 'test', value: BETA_FILE, required: true }],
    }),
  ],
});
const decision = { what: 'Kept alpha in one module', why: 'The test imports it from there.' };

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

/** A run whose planner fails the decision confirm, so the brief halts with its file written. */
async function haltOnDecisionConfirm(planned = plan) {
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
  const passing = passingVerdict({
    kind: 'final',
    taskIds: planned.tasks.map((task) => task.id),
    criterionIds: planned.criteria.map((criterion) => criterion.id),
  });
  writeFileSync(
    plannerPath,
    `const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString('utf8');
let answer;
if (prompt.includes('# Task Implementation Review') || prompt.includes('# Final Implementation Review')) {
  answer = ${JSON.stringify(passing)};
} else if (prompt.includes('Confirm reported decisions')) {
  process.stderr.write('The planner process crashed.\\n');
  process.exit(1);
} else if (prompt.includes('# Plan the change')) {
  answer = ${JSON.stringify({ result: planned })};
} else {
  throw new Error('Unexpected prompt: ' + prompt);
}
process.stdout.write(JSON.stringify(answer));
`,
  );
  writeFileSync(
    implementerPath,
    `import { mkdirSync, writeFileSync } from 'node:fs';
for await (const _chunk of process.stdin);
mkdirSync('src', { recursive: true });
writeFileSync(${JSON.stringify(ALPHA_FILE)}, "export const alpha = 'alpha';\\n");
console.log('Implemented T001');
console.log(JSON.stringify({
  status: 'done',
  filesChanged: [${JSON.stringify(ALPHA_FILE)}],
  touchedNotSuggested: [],
  notes: null,
  decisions: [${JSON.stringify(decision)}],
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

describe('e2e: Skip on a planner-call halt', () => {
  it('takes back the skipped brief file, so the review and the record do not carry it', async () => {
    const { target, sessionId } = await haltOnDecisionConfirm();
    const halted = readState(target, sessionId);
    expect(halted.pendingRecovery).toMatchObject({ reason: 'planner-call-failed', taskId: 'T001' });
    const workspaceDir = halted.workspace?.path ?? target.projectDir;
    expect(existsSync(join(workspaceDir, ALPHA_FILE))).toBe(true);

    const skipped = await cli(target, ['continue', sessionId, '--plain', '--action', 'skip']);

    expect(skipped.exitCode, `${skipped.stdout}\n${skipped.stderr}`).toBe(0);
    const ref = { projectDir: target.projectDir, sessionId };
    expect(readState(target, sessionId).tasks[0]?.status).toBe('skipped');
    expect(existsSync(join(workspaceDir, ALPHA_FILE))).toBe(false);
    const summary = readSessionSummary(ref);
    expect(summary).toBeDefined();
    expect(summary?.changedFiles).not.toContain(ALPHA_FILE);
    const { events } = await readRunEvents(ref);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'warning',
        message: expect.stringMatching(
          /^Restored 1 failing task change to the pre-task state: src\/alpha\.mjs/,
        ),
      }),
    );
    const lines = transcriptText(events).split('\n');
    const recoveryRows = lines.filter((line) => line.includes('Recovery  '));
    expect(recoveryRows).toHaveLength(1);
    expect(recoveryRows[0]).toMatch(/Skip task.*skipped\s*$/);
    const recoveryAt = lines.findIndex((line) => line.includes('Recovery  '));
    expect(
      lines.findIndex((line) => line.includes('Restored 1 failing task change')),
    ).toBeGreaterThan(recoveryAt);
  });

  it('shows Skip task on the dependency halt of the next brief as one Recovery row', async () => {
    const { target, sessionId } = await haltOnDecisionConfirm(dependentPlan);
    const firstSkip = await cli(target, ['continue', sessionId, '--plain', '--action', 'skip']);
    expect(firstSkip.exitCode, `${firstSkip.stdout}\n${firstSkip.stderr}`).toBe(1);
    expect(readState(target, sessionId).pendingRecovery).toMatchObject({
      reason: 'dependency-blocked',
      taskId: 'T002',
    });

    const secondSkip = await cli(target, ['continue', sessionId, '--plain', '--action', 'skip']);

    expect(secondSkip.exitCode, `${secondSkip.stdout}\n${secondSkip.stderr}`).toBe(0);
    const { events } = await readRunEvents({ projectDir: target.projectDir, sessionId });
    const lines = transcriptText(events).split('\n');
    const recoveryRows = lines.filter((line) => line.includes('Recovery  '));
    expect(recoveryRows).toHaveLength(2);
    expect(recoveryRows[1]).toMatch(/Dependency blocked.*Skip task.*skipped\s*$/);
    const settledT002 = lines.findIndex((line) => /T002 Add the beta value .*skipped/.test(line));
    expect(settledT002).toBeGreaterThan(lines.indexOf(recoveryRows[0] ?? ''));
    expect(lines.indexOf(recoveryRows[1] ?? '')).toBeGreaterThan(settledT002);
  });
});
