import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readyToApplyMessage } from '../../../src/cli/sessions/resolve.js';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import type { ConsultAnswer } from '../../../src/core/schemas/consult.js';
import { readActive } from '../../../src/core/sessions/active-pointer.js';
import { readRunRecord } from '../../../src/core/sessions/run-record-io.js';
import { readRunEvents } from '../../../src/engine/events/replay.js';
import { activateSafeCliShimPath } from '#testing/helpers/compatible-cli-shim.js';
import { makePlanProposal, makeTaskSpec } from '#testing/helpers/factories/plan.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { passingVerdict } from '#testing/helpers/typed-planner.js';
import type { IsolationStrategy } from '../../../src/core/schemas/enums.js';
import { plainUserMessage } from '../../../src/core/types/user-input.js';
import { applyRecoveryAction } from '../../../src/engine/orchestrator/recovery/actions.js';
import { createRecoveryBus } from '../../../src/engine/orchestrator/recovery/bus.js';
import {
  cli,
  createStopContinueFixture,
  readState,
  type StopContinueFixture,
} from '../helpers/stop-continue-fixture.js';

const RUN_TIMEOUT_MS = 120_000;

const alpha = makeTaskSpec({
  id: 'T001',
  title: 'Add the alpha value',
  intent: 'Return the alpha value.',
  criteria: ['C1'],
  suggestedFiles: ['src/alpha.mjs', 'src/alpha.test.mjs'],
  checks: [{ id: 'T001-K1', kind: 'test', value: 'src/alpha.test.mjs', required: true }],
});
const beta = makeTaskSpec({
  id: 'T002',
  title: 'Add the beta value',
  intent: 'Return the beta value.',
  criteria: ['C2'],
  suggestedFiles: ['src/beta.mjs', 'src/beta.test.mjs'],
  checks: [{ id: 'T002-K1', kind: 'test', value: 'src/beta.test.mjs', required: true }],
});
const plan = makePlanProposal({
  summary: 'Add two independently tested values.',
  decisions: [],
  criteria: [
    { id: 'C1', text: 'Alpha is the string alpha.', checkIds: ['T001-K1'] },
    { id: 'C2', text: 'Beta is the string beta.', checkIds: ['T002-K1'] },
  ],
  tasks: [alpha, beta],
});
const consult: ConsultAnswer = {
  answer: {
    diagnosis: 'The beta value does not match the value its test expects.',
    action: 'guidance',
    instructions: 'Export the string beta from src/beta.mjs.',
    context: null,
  },
};
const ALPHA_FILES = {
  'src/alpha.mjs': "export const alpha = 'alpha';\n",
  'src/alpha.test.mjs':
    "import { strict as assert } from 'node:assert';\nimport { alpha } from './alpha.mjs';\nassert.equal(alpha, 'alpha');\n",
};
const BETA_TEST =
  "import { strict as assert } from 'node:assert';\nimport { beta } from './beta.mjs';\nassert.equal(beta, 'beta');\n";
const HALT_ACTIONS = ['continue', 'skip-current-task', 'end-run'];
const HALT_MESSAGE = 'T002 used its consult allowance';
const HALT_CALLS = [
  'plan',
  'implement T001',
  'task-review',
  'implement T002',
  'implement T002',
  'consult',
  'implement T002',
  'consult',
  'implement T002',
];

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
 * The planner answers the plan, every consult with guidance, and each task and final review with
 * every id its prompt lists. The implementer lands T001, and writes T002's files on every attempt
 * with a value its test never accepts. The `task` review cadence runs each brief's checks at its
 * gate, so T002's required check fails every attempt and the ladder escalates.
 */
function writeRunners(target: StopContinueFixture, callsPath: string) {
  const plannerPath = join(target.tmpDir, 'planner.mjs');
  const implementerPath = join(target.tmpDir, 'implementer.mjs');
  const passing = passingVerdict({
    kind: 'final',
    taskIds: [alpha.id, beta.id],
    criterionIds: ['C1', 'C2'],
  });
  writeFileSync(
    plannerPath,
    `import { appendFileSync } from 'node:fs';
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
  answer = ${JSON.stringify(consult)};
} else if (prompt.includes('# Plan the change')) {
  kind = 'plan';
  answer = ${JSON.stringify({ result: plan })};
} else {
  throw new Error('Unexpected prompt: ' + prompt);
}
appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ kind }) + '\\n');
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
const title = prompt.match(/^## Task: (.+)$/m)?.[1];
const taskId = title === ${JSON.stringify(alpha.title)} ? 'T001' : title === ${JSON.stringify(beta.title)} ? 'T002' : undefined;
if (taskId === undefined) throw new Error('Unexpected brief: ' + prompt);
const callsPath = ${JSON.stringify(callsPath)};
const earlier = existsSync(callsPath)
  ? readFileSync(callsPath, 'utf8').split('\\n').filter((line) => line.includes('"taskId":"' + taskId + '"')).length
  : 0;
appendFileSync(callsPath, JSON.stringify({ kind: 'implement', taskId }) + '\\n');
const files = taskId === 'T001'
  ? ${JSON.stringify(ALPHA_FILES)}
  : {
      'src/beta.mjs': "export const beta = 'attempt " + (earlier + 1) + "';\\n",
      'src/beta.test.mjs': ${JSON.stringify(BETA_TEST)},
    };
for (const [file, source] of Object.entries(files)) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, source);
}
console.log('Implemented ' + taskId);
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
    workflow: { ...config.workflow, review: 'task' },
  });
}

function readCalls(callsPath: string): string[] {
  return readFileSync(callsPath, 'utf8')
    .trim()
    .split('\n')
    .map((line) => {
      const call: { kind: string; taskId?: string } = JSON.parse(line);
      return call.taskId === undefined ? call.kind : `${call.kind} ${call.taskId}`;
    });
}

/** Starts the run headless and returns once T002 has spent its consults and the run halted. */
async function startEscalatingRun(isolation: IsolationStrategy = 'worktree') {
  const target = createStopContinueFixture(() => '', { isolation });
  fixture = target;
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
  const sessionId = readActive(target.projectDir);
  if (sessionId === null) throw new Error(`The halted run saved no session: ${halted.stderr}`);
  return {
    target,
    callsPath,
    halted,
    sessionId,
    ref: { projectDir: target.projectDir, sessionId },
  };
}

describe('e2e: brief escalation', { timeout: 240_000 }, () => {
  it.each([1, 2])(
    'skips a checkout brief after %i halt(s) and preserves later user edits',
    async (halts) => {
      const { target, halted, sessionId, ref } = await startEscalatingRun('none');
      expect(halted.exitCode, `${halted.stdout}\n${halted.stderr}`).toBe(1);
      expect(readState(target, sessionId).pendingRecovery?.reason).toBe('consult-bound-spent');
      expect(existsSync(join(target.projectDir, 'src/beta.mjs'))).toBe(true);
      writeFileSync(join(target.projectDir, 'init.txt'), 'edited while halted\n');
      writeFileSync(join(target.projectDir, 'scratch.txt'), 'notes while halted\n');

      if (halts === 2) {
        const resumed = await applyRecoveryAction({
          ...ref,
          state: readState(target, sessionId),
          action: 'continue',
          comment: plainUserMessage('Try the brief again.'),
          bus: createRecoveryBus(ref),
          config: loadConfig(target.projectDir).config,
        });
        expect(resumed.ok).toBe(true);
        const haltedAgain = await cli(target, ['continue', sessionId], {
          timeoutMs: RUN_TIMEOUT_MS,
        });
        expect(haltedAgain.exitCode, haltedAgain.stderr).toBe(1);
        expect(readState(target, sessionId).pendingRecovery?.reason).toBe('consult-bound-spent');
      }

      const continued = await cli(target, ['continue', sessionId, '--action', 'skip'], {
        timeoutMs: RUN_TIMEOUT_MS,
      });

      expect(continued.exitCode, `${continued.stdout}\n${continued.stderr}`).toBe(0);
      expect(readState(target, sessionId).tasks[1]?.status).toBe('skipped');
      expect(existsSync(join(target.projectDir, 'src/beta.mjs'))).toBe(false);
      expect(existsSync(join(target.projectDir, 'src/beta.test.mjs'))).toBe(false);
      expect(readFileSync(join(target.projectDir, 'src/alpha.mjs'), 'utf8')).toBe(
        ALPHA_FILES['src/alpha.mjs'],
      );
      expect(readFileSync(join(target.projectDir, 'init.txt'), 'utf8')).toBe(
        'edited while halted\n',
      );
      expect(readFileSync(join(target.projectDir, 'scratch.txt'), 'utf8')).toBe(
        'notes while halted\n',
      );
    },
  );

  it('halts Needs you when a brief spends its consults, waiting for you with its files kept', async () => {
    const { target, callsPath, halted, sessionId, ref } = await startEscalatingRun();

    expect(halted.exitCode, `${halted.stdout}\n${halted.stderr}`).toBe(1);
    expect(halted.stdout).toContain('task T001: done');
    expect(halted.stderr).toContain(`Needs you (consult-bound-spent): ${HALT_MESSAGE}`);
    expect(halted.stderr).toContain('Recommended: continue');
    expect(halted.stderr).toContain(
      `Continue with: splitbrief continue ${sessionId}, then choose Continue in the recovery panel`,
    );
    expect(halted.stderr).not.toContain('[--plain|--json]');
    expect(readCalls(callsPath)).toEqual(HALT_CALLS);

    const state = readState(target, sessionId);
    expect(state.pendingRecovery).toMatchObject({
      reason: 'consult-bound-spent',
      status: 'awaiting-user',
      seat: 'build',
      taskId: 'T002',
      message: HALT_MESSAGE,
      availableActions: HALT_ACTIONS,
      recommendedAction: 'continue',
      attempts: 4,
      facts: { consults: 2, consultAllowance: 2, attempts: 4, attemptAllowance: 8 },
    });
    expect(state.tasks.map((task) => ({ id: task.id, status: task.status }))).toEqual([
      { id: 'T001', status: 'done' },
      { id: 'T002', status: 'in_progress' },
    ]);
    if (state.workspace === undefined) throw new Error('The halted run recorded no workspace');
    expect(readFileSync(join(state.workspace.path, 'src/beta.mjs'), 'utf8')).toBe(
      "export const beta = 'attempt 4';\n",
    );

    expect(readRunRecord(ref).status).toMatchObject({
      kind: 'open',
      stop: {
        kind: 'waiting-for-you',
        on: { kind: 'halt', issue: { reason: 'consult-bound-spent', taskId: 'T002' } },
      },
      resumeAt: { kind: 'brief', taskId: 'T002' },
    });

    const { events } = await readRunEvents(ref);
    expect(
      events.flatMap((event) =>
        event.type === 'task_retry' && event.taskId === 'T002' ? [event.taskId] : [],
      ),
    ).toEqual(['T002']);
    expect(
      events.flatMap((event) => (event.type === 'task_escalating' ? [event.taskId] : [])),
    ).toEqual(['T002']);
    expect(
      events.flatMap((event) =>
        event.type === 'consult_answered'
          ? [{ taskId: event.taskId, seat: event.seat, reason: event.reason, action: event.action }]
          : [],
      ),
    ).toEqual(
      Array.from({ length: 2 }, () => ({
        taskId: 'T002',
        seat: 'plan',
        reason: 'failed',
        action: 'guidance',
      })),
    );
    expect(events.filter((event) => event.type === 'consult_bound_spent')).toHaveLength(1);
    const prompted = events.filter((event) => event.type === 'recovery_prompted');
    expect(prompted).toHaveLength(1);
    expect(prompted[0]).toMatchObject({
      issueId: state.pendingRecovery?.id,
      reason: 'consult-bound-spent',
      taskId: 'T002',
      availableActions: HALT_ACTIONS,
      recommendedAction: 'continue',
      resumeCommand: `splitbrief continue ${sessionId}, then choose Continue in the recovery panel`,
    });
  });

  it('continues headless past the halt by skipping the brief and reaches ready to apply', async () => {
    const { target, callsPath, halted, sessionId, ref } = await startEscalatingRun();
    expect(halted.exitCode, `${halted.stdout}\n${halted.stderr}`).toBe(1);
    expect(readState(target, sessionId).pendingRecovery?.reason).toBe('consult-bound-spent');

    const continued = await cli(target, ['continue', sessionId, '--action', 'skip'], {
      timeoutMs: RUN_TIMEOUT_MS,
    });

    expect(continued.exitCode, `${continued.stdout}\n${continued.stderr}`).toBe(0);
    expect(continued.stderr).toContain(readyToApplyMessage(sessionId));
    expect(readCalls(callsPath)).toEqual([...HALT_CALLS, 'final-review']);

    const state = readState(target, sessionId);
    expect(state.pendingRecovery).toBeUndefined();
    expect(state.tasks.map((task) => ({ id: task.id, status: task.status }))).toEqual([
      { id: 'T001', status: 'done' },
      { id: 'T002', status: 'skipped' },
    ]);
    if (state.workspace === undefined) throw new Error('The continued run recorded no workspace');
    expect(existsSync(join(state.workspace.path, 'src/beta.mjs'))).toBe(false);
    expect(existsSync(join(state.workspace.path, 'src/beta.test.mjs'))).toBe(false);
    expect(readFileSync(join(state.workspace.path, 'src/alpha.mjs'), 'utf8')).toBe(
      ALPHA_FILES['src/alpha.mjs'],
    );
    expect(readRunRecord(ref).status).toEqual({ kind: 'ready-to-apply', override: false });

    const { events } = await readRunEvents(ref);
    expect(events.filter((event) => event.type === 'recovery_resolved')).toMatchObject([
      {
        reason: 'consult-bound-spent',
        action: 'skip-current-task',
        outcome: 'skipped-current-task',
      },
    ]);
    expect(events.filter((event) => event.type === 'task_skipped')).toMatchObject([
      { taskId: 'T002' },
    ]);
  });
});
