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
const STALE_TEXT = 'inputs changed since the brief was compiled';

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
const ALPHA_FILES = {
  'src/alpha.mjs': "export const alpha = 'alpha';\n",
  'src/alpha.test.mjs':
    "import { strict as assert } from 'node:assert';\nimport { alpha } from './alpha.mjs';\nassert.equal(alpha, 'alpha');\n",
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

/**
 * The implementer writes the brief's two files; its first attempt reports a decision. The planner
 * process exits 1 on the decision confirm, so the run halts with the files on disk. Every consult
 * logs its reason.
 */
function writeRunners(target: StopContinueFixture, callsPath: string) {
  const plannerPath = join(target.tmpDir, 'planner.mjs');
  const implementerPath = join(target.tmpDir, 'implementer.mjs');
  const passing = passingVerdict({ kind: 'final', taskIds: [alpha.id], criterionIds: ['C1'] });
  writeFileSync(
    plannerPath,
    `import { appendFileSync } from 'node:fs';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString('utf8');
const log = (entry) => appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(entry) + '\\n');
let answer;
if (prompt.includes('# Final Implementation Review') || prompt.includes('# Task Implementation Review')) {
  answer = ${JSON.stringify(passing)};
} else if (prompt.includes('# Confirm reported decisions')) {
  log({ kind: 'consult', reason: 'deviation' });
  process.stderr.write('planner process stopped\\n');
  process.exit(1);
} else if (prompt.includes('# Consult on a failing task') || prompt.includes('# Consult continued')) {
  log({ kind: 'consult', reason: prompt.match(/^#+ Reason\\s*\\n+\\s*(\\S+) —/m)?.[1] ?? 'unknown' });
  answer = ${JSON.stringify(guidanceConsult('Keep the brief as it is.'))};
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
import { dirname } from 'node:path';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString('utf8');
const calls = readFileSync(${JSON.stringify(callsPath)}, 'utf8');
const attempt = calls.split('\\n').filter((line) => line.includes('"kind":"implement"')).length;
appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ kind: 'implement', prompt }) + '\\n');
for (const [file, source] of Object.entries(${JSON.stringify(ALPHA_FILES)})) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, source);
}
// Each attempt marks its own change, so a retry over the first attempt's files still changes one.
appendFileSync('src/alpha.mjs', '// attempt ' + attempt + '\\n');
console.log('Implemented T001');
console.log(JSON.stringify({
  status: 'done',
  filesChanged: ${JSON.stringify(Object.keys(ALPHA_FILES))},
  touchedNotSuggested: [],
  notes: null,
  decisions: attempt === 0 ? [{ what: 'Kept alpha in one module', why: 'The test imports it.' }] : [],
}));
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
    workflow: { ...config.workflow, approve: 'none' },
  });
}

function readCalls(callsPath: string): { kind: string; reason?: string; prompt?: string }[] {
  return readFileSync(callsPath, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}

describe('e2e: Try again on a brief that wrote its own files', { timeout: 360_000 }, () => {
  it('restarts the brief without a stale consult and keeps it creating its files', async () => {
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

    const halted = await cli(target, ['start', 'smoke'], { timeoutMs: RUN_TIMEOUT_MS });
    expect(halted.exitCode, `${halted.stdout}\n${halted.stderr}`).toBe(1);
    const sessionId = readdirSync(sessionsRoot(target.projectDir))[0];
    if (sessionId === undefined) throw new Error('Missing session');
    const haltState = readState(target, sessionId);
    expect(haltState.pendingRecovery).toMatchObject({
      reason: 'planner-call-failed',
      taskId: 'T001',
    });
    const consultsAtHalt = haltState.lineages?.T001?.consults;

    const continued = await cli(target, ['continue', sessionId, '--action', 'retry'], {
      timeoutMs: RUN_TIMEOUT_MS,
    });
    expect(continued.exitCode, `${continued.stdout}\n${continued.stderr}`).toBe(0);

    const calls = readCalls(callsPath);
    expect(calls.filter((call) => call.kind === 'consult').map((call) => call.reason)).toEqual([
      'deviation',
    ]);
    const builds = calls.filter((call) => call.kind === 'implement');
    expect(builds).toHaveLength(2);
    expect(builds[1]?.prompt).not.toContain(STALE_TEXT);

    const state = readState(target, sessionId);
    expect(state.phase).toBe('complete');
    expect(state.lineages?.T001?.consults).toBe(consultsAtHalt);
    expect(state.tasks[0]?.action).toBe('create');
  });
});
