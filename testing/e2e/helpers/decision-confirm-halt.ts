import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, vi } from 'vitest';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { sessionsRoot } from '../../../src/core/paths.js';
import type { PlanProposal } from '../../../src/core/schemas/plan.js';
import { activateSafeCliShimPath } from '#testing/helpers/compatible-cli-shim.js';
import { makePlanProposal, makeTaskSpec } from '#testing/helpers/factories/plan.js';
import { passingVerdict } from '#testing/helpers/typed-planner.js';
import {
  cli,
  createStopContinueFixture,
  type StopContinueFixture,
} from './stop-continue-fixture.js';

export const ALPHA_FILE = 'src/alpha.mjs';
const alpha = makeTaskSpec({
  id: 'T001',
  title: 'Add the alpha value',
  intent: 'Return the alpha value.',
  criteria: ['C1'],
  suggestedFiles: [ALPHA_FILE],
  checks: [{ id: 'T001-K1', kind: 'test', value: ALPHA_FILE, required: true }],
});
export const plan = makePlanProposal({
  summary: 'Add one value.',
  decisions: [],
  criteria: [{ id: 'C1', text: 'Alpha is the string alpha.', checkIds: ['T001-K1'] }],
  tasks: [alpha],
});
const BETA_FILE = 'src/beta.mjs';
/** T002 depends on T001, so a skipped T001 halts T002 on its dependency. */
export const dependentPlan = makePlanProposal({
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

/**
 * A project whose planner fails the decision confirm, so T001 halts with its file written.
 * The caller keeps both values for its cleanup before it starts the run.
 */
export function decisionConfirmHaltFixture(planned: PlanProposal): {
  fixture: StopContinueFixture;
  restorePath: () => void;
} {
  const fixture = createStopContinueFixture(() => '');
  const restorePath = activateSafeCliShimPath(fixture.tmpDir);
  const offlinePath = join(fixture.tmpDir, 'offline.mjs');
  writeFileSync(
    offlinePath,
    "globalThis.fetch = async () => { throw new Error('E2E network disabled'); };\n",
  );
  vi.stubEnv('NODE_OPTIONS', `--import=${offlinePath}`);
  const plannerPath = join(fixture.tmpDir, 'planner.mjs');
  const implementerPath = join(fixture.tmpDir, 'implementer.mjs');
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
  const config = loadConfig(fixture.projectDir).config;
  if (config.planner.kind !== 'shell' || config.implementer.kind !== 'agent') {
    throw new Error('Expected local shell and agent fixture runners');
  }
  writeConfig(fixture.projectDir, {
    ...config,
    planner: { ...config.planner, args: [plannerPath] },
    implementer: { ...config.implementer, args: [implementerPath] },
  });
  return { fixture, restorePath };
}

/** Starts the run, which halts on the decision confirm, and returns its session id. */
export async function startToHalt(fixture: StopContinueFixture): Promise<string> {
  const halted = await cli(fixture, ['start', 'smoke']);
  expect(halted.exitCode, `${halted.stdout}\n${halted.stderr}`).toBe(1);
  const [sessionId] = readdirSync(sessionsRoot(fixture.projectDir));
  if (sessionId === undefined) throw new Error('Missing session');
  return sessionId;
}
