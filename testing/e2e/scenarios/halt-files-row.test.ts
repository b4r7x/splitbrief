import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { activateSafeCliShimPath } from '#testing/helpers/compatible-cli-shim.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { makePlanProposal, makeTaskSpec } from '#testing/helpers/factories/plan.js';
import type { renderFeature } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { openHaltedRun } from '../helpers/halted-run-screen.js';
import {
  cli,
  createStopContinueFixture,
  type StopContinueFixture,
} from '../helpers/stop-continue-fixture.js';

const SOURCE_FILE = 'lib/clamp.mjs';
const TEST_FILE = 'test/clamp.test.mjs';
const clamp = makeTaskSpec({
  id: 'T001',
  title: 'Add clamp helper with one test',
  intent: 'Add a clamp helper and its test.',
  criteria: ['C1'],
  suggestedFiles: [SOURCE_FILE, TEST_FILE],
  checks: [{ id: 'T001-K1', kind: 'test', value: TEST_FILE, required: true }],
});
const plan = makePlanProposal({
  summary: 'Add one helper.',
  decisions: [],
  criteria: [{ id: 'C1', text: 'clamp bounds a number.', checkIds: ['T001-K1'] }],
  tasks: [clamp],
});
const decision = { what: 'Kept clamp in one module', why: 'The test imports it from there.' };

let fixture: StopContinueFixture | undefined;
let ui: ReturnType<typeof renderFeature> | undefined;
let restorePath: (() => void) | undefined;

beforeEach(() => resetAllStores());

afterEach(() => {
  ui?.unmount();
  ui = undefined;
  resetAllStores();
  restorePath?.();
  vi.unstubAllEnvs();
  if (fixture !== undefined) cleanupTempDir(fixture.tmpDir);
  fixture = undefined;
  restorePath = undefined;
});

/** A run whose planner crashes on the decision confirm, so the two-file brief halts. */
async function haltTwoFileBrief() {
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
  writeFileSync(
    plannerPath,
    `const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString('utf8');
if (prompt.includes('Confirm reported decisions')) {
  process.stderr.write('The planner process crashed.\\n');
  process.exit(1);
}
if (!prompt.includes('# Plan the change')) throw new Error('Unexpected prompt: ' + prompt);
process.stdout.write(${JSON.stringify(JSON.stringify({ result: plan }))});
`,
  );
  writeFileSync(
    implementerPath,
    `import { mkdirSync, writeFileSync } from 'node:fs';
for await (const _chunk of process.stdin);
mkdirSync('lib', { recursive: true });
mkdirSync('test', { recursive: true });
writeFileSync(${JSON.stringify(SOURCE_FILE)}, 'export const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));\\n');
writeFileSync(${JSON.stringify(TEST_FILE)}, "import { clamp } from '../lib/clamp.mjs';\\nif (clamp(5, 0, 3) !== 3) process.exit(1);\\n");
console.log(JSON.stringify({
  status: 'done',
  filesChanged: [${JSON.stringify(SOURCE_FILE)}, ${JSON.stringify(TEST_FILE)}],
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
  return target;
}

describe('e2e: the Files row of a halt', () => {
  it('names every file of a two-file brief, not only its first', async () => {
    const target = await haltTwoFileBrief();

    const opened = await openHaltedRun(target, { heading: 'Seat down' });
    ui = opened.screen;

    expect(opened.state.pendingRecovery).toMatchObject({
      reason: 'planner-call-failed',
      taskId: 'T001',
      files: [SOURCE_FILE, TEST_FILE],
    });
    expect(stripAnsiStyles(opened.screen.lastFrame())).toContain(
      `Files ${SOURCE_FILE} · ${TEST_FILE}`,
    );
  });
});
