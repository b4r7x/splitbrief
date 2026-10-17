import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import {
  DRIFT_REPORT_FILE,
  EVIDENCE_FILE,
  REVIEW_PACKET_JSON_FILE,
  REVIEW_PACKET_MARKDOWN_FILE,
  sessionDir,
  sessionsRoot,
} from '../../../src/core/paths.js';
import type { ConsultAnswer } from '../../../src/core/schemas/consult.js';
import { ReviewPacketSchema } from '../../../src/core/schemas/review-packet.js';
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

const RUN_TIMEOUT_MS = 150_000;
const HOLD_WAIT_MS = 75_000;

const clamp = makeTaskSpec({
  id: 'T001',
  title: 'Add the clamp helper',
  intent: 'Clamp a value into a range.',
  criteria: ['C1'],
  suggestedFiles: ['src/clamp.mjs', 'src/clamp.test.mjs'],
  checks: [{ id: 'T001-K1', kind: 'test', value: 'src/clamp.test.mjs', required: true }],
});
const plan = makePlanProposal({
  summary: 'Add a tested clamp helper.',
  decisions: [],
  criteria: [{ id: 'C1', text: 'clamp keeps a value in its range.', checkIds: ['T001-K1'] }],
  tasks: [clamp],
});
const consult: ConsultAnswer = {
  answer: {
    diagnosis: 'The files are already in the workspace; the retry changed nothing.',
    action: 'verify',
    checkIds: ['T001-K1'],
    reason: 'T001-K1 covers both files of the brief.',
  },
};
const FILES = ['src/clamp.mjs', 'src/clamp.test.mjs'];

let fixture: StopContinueFixture | undefined;
let restorePath: (() => void) | undefined;

afterEach(() => {
  restorePath?.();
  vi.unstubAllEnvs();
  if (fixture !== undefined) {
    writeFileSync(join(fixture.tmpDir, 'release'), '');
    cleanupTempDir(fixture.tmpDir);
  }
  fixture = undefined;
  restorePath = undefined;
});

/**
 * The first implementer call writes both files of the brief and holds, so the run stops inside
 * it. Every later call changes nothing. The brief's test needs a service flag that only the
 * consult brings up, so the gate fails until the planner answers the consult with `verify`.
 */
function writeRunners(target: StopContinueFixture, paths: { calls: string; service: string }) {
  const plannerPath = join(target.tmpDir, 'planner.mjs');
  const implementerPath = join(target.tmpDir, 'implementer.mjs');
  const passing = passingVerdict({ kind: 'final', taskIds: [clamp.id], criterionIds: ['C1'] });
  const clampTest = `import { strict as assert } from 'node:assert';
import { existsSync } from 'node:fs';
import { clamp } from './clamp.mjs';
assert.ok(existsSync(${JSON.stringify(paths.service)}), 'the clamp service is down');
assert.equal(clamp(0, 0, 10), 0);
`;
  writeFileSync(
    plannerPath,
    `import { appendFileSync, writeFileSync } from 'node:fs';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString('utf8');
let kind;
let answer;
if (prompt.includes('# Final Implementation Review') || prompt.includes('# Task Implementation Review')) {
  kind = prompt.includes('# Final Implementation Review') ? 'final-review' : 'task-review';
  const ids = (label) => {
    const match = prompt.match(new RegExp('^' + label + ' (.+)$', 'm'));
    if (!match) throw new Error('Missing required ids: ' + label);
    return match[1].split(',').map((id) => id.trim()).filter((id) => id !== '' && id !== 'none');
  };
  const passing = ${JSON.stringify(passing)};
  answer = {
    ...passing,
    tasks: ids('Task ids:').map((id) => passing.tasks.find((task) => task.id === id)),
    criteria: ids('Criterion ids:').map((id) => passing.criteria.find((criterion) => criterion.id === id)),
  };
} else if (prompt.includes('# Consult on a failing task') || prompt.includes('# Consult continued')) {
  kind = 'consult';
  writeFileSync(${JSON.stringify(paths.service)}, 'up\\n');
  answer = ${JSON.stringify(consult)};
} else if (prompt.includes('# Plan the change')) {
  kind = 'plan';
  answer = ${JSON.stringify({ result: plan })};
} else {
  throw new Error('Unexpected prompt: ' + prompt);
}
appendFileSync(${JSON.stringify(paths.calls)}, kind + '\\n');
process.stdout.write(JSON.stringify(answer));
`,
  );
  writeFileSync(
    implementerPath,
    `import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
for await (const chunk of process.stdin) void chunk;
appendFileSync(${JSON.stringify(paths.calls)}, 'implement\\n');
if (existsSync(${JSON.stringify(join(target.tmpDir, 'holding'))})) {
  console.log('Both files are already in place.');
  process.exit(0);
}
mkdirSync('src', { recursive: true });
writeFileSync('src/clamp.mjs', 'export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));\\n');
writeFileSync('src/clamp.test.mjs', ${JSON.stringify(clampTest)});
writeFileSync(${JSON.stringify(join(target.tmpDir, 'holding'))}, String(process.pid));
const deadline = Date.now() + 180000;
while (!existsSync(${JSON.stringify(join(target.tmpDir, 'release'))}) && Date.now() < deadline) await delay(50);
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
    validation: { ...config.validation, testCommand: 'node --test' },
    workflow: { ...config.workflow, review: 'task', approve: 'none' },
  });
}

async function startAndStop(target: StopContinueFixture): Promise<void> {
  let groupPid: number | undefined;
  const run = cli(target, ['start', 'smoke'], {
    timeoutMs: RUN_TIMEOUT_MS,
    onSpawn: (pid) => {
      groupPid = pid;
    },
  });
  const holding = join(target.tmpDir, 'holding');
  const deadline = Date.now() + HOLD_WAIT_MS;
  while (!existsSync(holding) && Date.now() < deadline) await delay(100);
  if (!existsSync(holding)) throw new Error('the implementer never reached its hold');
  if (groupPid === undefined) throw new Error('the CLI reported no pid to signal');
  process.kill(-groupPid, 'SIGINT');
  await run;
}

describe('e2e: consult verify after a stop', { timeout: 300_000 }, () => {
  it('records both files a brief made before the stop when a consult verify completes it', async () => {
    fixture = createStopContinueFixture(() => '', { isolation: 'none' });
    const target = fixture;
    restorePath = activateSafeCliShimPath(target.tmpDir);
    const offlinePath = join(target.tmpDir, 'offline.mjs');
    writeFileSync(
      offlinePath,
      "globalThis.fetch = async () => { throw new Error('E2E network disabled'); };\n",
    );
    vi.stubEnv('NODE_OPTIONS', `--import=${offlinePath}`);
    const calls = join(target.tmpDir, 'calls.txt');
    writeRunners(target, { calls, service: join(target.tmpDir, 'clamp-service.flag') });

    await startAndStop(target);
    const resumed = await cli(target, ['continue'], { timeoutMs: RUN_TIMEOUT_MS });

    expect(resumed.exitCode, `${resumed.stdout}\n${resumed.stderr}`).toBe(0);
    const sessionId = readdirSync(sessionsRoot(target.projectDir))[0];
    if (sessionId === undefined) throw new Error('Missing session');
    expect(readState(target, sessionId).tasks.map((task) => task.status)).toEqual(['done']);
    const { events } = await readRunEvents({ projectDir: target.projectDir, sessionId });
    expect(
      events.flatMap((event) => (event.type === 'consult_answered' ? [event.action] : [])),
    ).toEqual(['verify']);
    expect(
      events.flatMap((event) => (event.type === 'task_completed' ? [event.method] : [])),
    ).toEqual(['consulted']);

    const dir = sessionDir(target.projectDir, sessionId);
    const drift = JSON.parse(readFileSync(join(dir, DRIFT_REPORT_FILE), 'utf8'));
    expect(drift.changedFiles).toEqual(FILES);
    expect(drift.findings).toEqual([]);
    const ledger = JSON.parse(readFileSync(join(dir, EVIDENCE_FILE), 'utf8'));
    expect(ledger.tasks).toMatchObject([{ id: 'T001', method: 'consulted', changedFiles: FILES }]);
    const packet = ReviewPacketSchema.parse(
      JSON.parse(readFileSync(join(dir, REVIEW_PACKET_JSON_FILE), 'utf8')),
    );
    expect(packet.changes.provenance?.promotedFiles).toEqual(FILES);
    expect(readFileSync(join(dir, REVIEW_PACKET_MARKDOWN_FILE), 'utf8')).toContain(
      `Recorded run effects: ${FILES.join(', ')}.`,
    );
  });
});
