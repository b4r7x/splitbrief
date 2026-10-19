import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { readActive } from '../../../src/core/sessions/active-pointer.js';
import { deriveRunStatus } from '../../../src/core/sessions/run-status.js';
import { plainUserMessage } from '../../../src/core/types/user-input.js';
import { readRunEvents } from '../../../src/engine/events/replay.js';
import { applyRecoveryAction } from '../../../src/engine/orchestrator/recovery/actions.js';
import { createRecoveryBus } from '../../../src/engine/orchestrator/recovery/bus.js';
import { resetWorkflow } from '../../../src/stores/workflow/actions/reset.js';
import { activateSafeCliShimPath } from '#testing/helpers/compatible-cli-shim.js';
import { makePlanProposal, makeTaskSpec } from '#testing/helpers/factories/plan.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import {
  cli,
  createStopContinueFixture,
  readState,
  type StopContinueFixture,
} from '../helpers/stop-continue-fixture.js';
import { transcriptText } from '../helpers/transcript-text.js';

const RUN_TIMEOUT_MS = 150_000;

const TOTAL_FILE = 'src/total.mjs';
const TOTAL_TEST_FILE = 'src/total.test.mjs';
const TOTAL_SOURCE = 'export const total = (a, b) => a + b;\n';
const TOTAL_FIXED = 'export const total = (a, b) => Number(a) + Number(b);\n';
const TOTAL_TEST_SOURCE = `import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { total } from './total.mjs';

test('total adds two numbers', () => {
  assert.equal(total(1, 2), 3);
});
`;
const FAILED = 'total("1", "2") returns "12".';
const NOTE = 'Make total read numeric strings as numbers.';

const brief = makeTaskSpec({
  id: 'T001',
  title: 'Add the total helper',
  intent: 'Return the sum of two numbers.',
  criteria: ['C1'],
  suggestedFiles: [TOTAL_FILE, TOTAL_TEST_FILE],
  checks: [{ id: 'T001-K1', kind: 'test', value: TOTAL_TEST_FILE, required: true }],
});
const repair = makeTaskSpec({
  id: 'T002',
  title: 'Repair total',
  intent: 'Make total add numeric strings.',
  criteria: ['C1'],
  suggestedFiles: [TOTAL_FILE],
  checks: [{ id: 'T002-K1', kind: 'test', value: TOTAL_TEST_FILE, required: true }],
});
const noteFix = makeTaskSpec({
  ...repair,
  title: 'Read numeric strings in total',
  intent: 'Convert both operands to numbers before adding them.',
});
const plan = makePlanProposal({
  summary: 'Add a total helper with its test.',
  decisions: [],
  criteria: [{ id: 'C1', text: 'total returns the sum.', checkIds: ['T001-K1'] }],
  tasks: [brief],
});
const finding = {
  id: 'F1',
  kind: 'defect',
  severity: 'blocking',
  taskId: brief.id,
  criterionId: 'C1',
  file: TOTAL_FILE,
  line: null,
  text: FAILED,
  acceptance: null,
  checkIds: null,
};
/** The note's line in the review prompt's Pending Inputs section. */
const PENDING_NOTE = `(user · defect) — ${NOTE}`;

type Call = { kind: string; title?: string; prompt?: string };

let fixture: StopContinueFixture | undefined;
let restorePath: (() => void) | undefined;

afterEach(() => {
  restorePath?.();
  vi.unstubAllEnvs();
  resetWorkflow();
  if (fixture !== undefined) cleanupTempDir(fixture.tmpDir);
  fixture = undefined;
  restorePath = undefined;
});

function readCalls(path: string): Call[] {
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}

/**
 * The first three final reviews fail, so the third halts at the fix cycle cap. A review that holds
 * the note answers it with a fix brief; every later review passes.
 */
function plannerScript(callsPath: string): string {
  return `import { appendFileSync, existsSync, readFileSync } from 'node:fs';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString('utf8');
const reviews = () =>
  existsSync(${JSON.stringify(callsPath)})
    ? readFileSync(${JSON.stringify(callsPath)}, 'utf8')
        .split('\\n')
        .filter((line) => line !== '' && JSON.parse(line).kind === 'final-review').length
    : 0;
const ids = (label) => {
  const value = prompt.match(new RegExp('^' + label + ' (.+)$', 'm'))?.[1].trim();
  if (value === undefined) throw new Error('Missing ids: ' + label);
  return value === 'none' ? [] : value.split(',').map((id) => id.trim());
};
let call;
let answer;
if (prompt.includes('# Final Implementation Review')) {
  call = { kind: 'final-review', prompt };
  answer = {
    tasks: ids('Task ids:').map((id) => ({ id, plan: 'met', note: '' })),
    criteria: ids('Criterion ids:').map((id) => ({ id, status: 'pass', evidence: '' })),
    findings: [],
    fixTasks: [],
    rejected: [],
    verify: [],
    ask: null,
  };
  const note = prompt.match(/^- \\*\\*(U\\d+)\\*\\* (.+)$/m);
  if (note?.[2] === ${JSON.stringify(PENDING_NOTE)}) {
    answer.fixTasks = [{ ...${JSON.stringify(noteFix)}, findingIds: [note[1]] }];
  } else if (reviews() < 3) {
    const finding = ${JSON.stringify(finding)};
    answer.criteria = answer.criteria.map((criterion) =>
      criterion.id === finding.criterionId ? { ...criterion, status: 'fail', evidence: finding.text } : criterion,
    );
    answer.findings = [finding];
    answer.fixTasks = [{ ...${JSON.stringify(repair)}, findingIds: [finding.id] }];
  }
} else if (prompt.includes('# Plan the change')) {
  call = { kind: 'plan' };
  answer = ${JSON.stringify({ result: plan })};
} else {
  throw new Error('Unexpected prompt: ' + prompt);
}
appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(call) + '\\n');
process.stdout.write(JSON.stringify(answer));
`;
}

/** Each repair writes a new line, so no fix brief ends without a change. */
function implementerScript(callsPath: string): string {
  return `import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString('utf8');
const title = prompt.match(/^## Task: (.+)$/m)?.[1];
const builds = readFileSync(${JSON.stringify(callsPath)}, 'utf8').split('\\n').filter((line) => line !== '' && JSON.parse(line).kind === 'implement').length;
const files = {
  ${JSON.stringify(brief.title)}: { ${JSON.stringify(TOTAL_FILE)}: ${JSON.stringify(TOTAL_SOURCE)}, ${JSON.stringify(TOTAL_TEST_FILE)}: ${JSON.stringify(TOTAL_TEST_SOURCE)} },
  ${JSON.stringify(repair.title)}: { ${JSON.stringify(TOTAL_FILE)}: ${JSON.stringify(TOTAL_SOURCE)} + '// repair ' + builds + '\\n' },
  ${JSON.stringify(noteFix.title)}: { ${JSON.stringify(TOTAL_FILE)}: ${JSON.stringify(TOTAL_FIXED)} },
}[title];
if (!files) throw new Error('Unexpected brief: ' + prompt);
appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ kind: 'implement', title, prompt }) + '\\n');
mkdirSync('src', { recursive: true });
for (const [file, source] of Object.entries(files)) writeFileSync(file, source);
console.log('Implemented ' + title);
`;
}

describe('e2e: Fix again after a failed final review', { timeout: 300_000 }, () => {
  it('sends the note to the reviewer, builds the fix brief it answers with, and records Fix again', async () => {
    fixture = createStopContinueFixture(() => '');
    const target = fixture;
    restorePath = activateSafeCliShimPath(target.tmpDir);
    const callsPath = join(target.tmpDir, 'calls.jsonl');
    const plannerPath = join(target.tmpDir, 'planner.mjs');
    const implementerPath = join(target.tmpDir, 'implementer.mjs');
    const offlinePath = join(target.tmpDir, 'offline.mjs');
    writeFileSync(
      offlinePath,
      "globalThis.fetch = async () => { throw new Error('E2E network disabled'); };\n",
    );
    vi.stubEnv('NODE_OPTIONS', `--import=${offlinePath}`);
    writeFileSync(plannerPath, plannerScript(callsPath));
    writeFileSync(implementerPath, implementerScript(callsPath));
    const config = loadConfig(target.projectDir).config;
    if (config.planner.kind !== 'shell' || config.implementer.kind !== 'agent') {
      throw new Error('Expected local shell and agent fixture runners');
    }
    writeConfig(target.projectDir, {
      ...config,
      planner: { ...config.planner, args: [plannerPath] },
      implementer: { ...config.implementer, args: [implementerPath] },
      workflow: { ...config.workflow, approve: 'none' },
      validation: { ...config.validation, endChecks: false, testCommand: 'node --test' },
    });

    const halted = await cli(target, ['start', 'total'], { timeoutMs: RUN_TIMEOUT_MS });
    expect(halted.exitCode, `${halted.stdout}\n${halted.stderr}`).toBe(1);
    const sessionId = readActive(target.projectDir);
    if (sessionId === null) throw new Error(`The halted run saved no session: ${halted.stderr}`);
    expect(halted.stderr).toContain(
      `Continue with: splitbrief continue ${sessionId}, then choose Fix again in the recovery panel`,
    );
    const ref = { projectDir: target.projectDir, sessionId };
    const failed = readState(target, sessionId);
    expect(failed.pendingRecovery).toMatchObject({
      reason: 'review-failed',
      recommendedAction: 'revise',
    });
    expect(failed.pendingRecovery?.availableActions).toContain('revise');

    const revised = await applyRecoveryAction({
      ...ref,
      state: failed,
      action: 'revise',
      comment: plainUserMessage(NOTE),
      bus: createRecoveryBus(ref),
      config: loadConfig(target.projectDir).config,
    });
    expect(revised.ok).toBe(true);
    const queued = readState(target, sessionId);
    expect(queued.phase).toBe('final-review');
    expect(queued.pendingRecovery).toBeUndefined();
    expect(queued.pendingTriage?.inputs).toMatchObject([
      { kind: 'defect', source: 'user', text: NOTE },
    ]);
    const inputId = queued.pendingTriage?.inputs[0]?.id;

    const continued = await cli(target, ['continue', sessionId], { timeoutMs: RUN_TIMEOUT_MS });
    expect(continued.exitCode, `${continued.stdout}\n${continued.stderr}`).toBe(0);

    const calls = readCalls(callsPath);
    expect(calls.map((call) => call.title ?? call.kind)).toEqual([
      'plan',
      brief.title,
      'final-review',
      repair.title,
      'final-review',
      repair.title,
      'final-review',
      'final-review',
      noteFix.title,
      'final-review',
    ]);
    expect(calls.slice(0, 7).some((call) => call.prompt?.includes(NOTE))).toBe(false);
    expect(calls[7]?.prompt).toContain(`- **${inputId}** ${PENDING_NOTE}`);
    expect(calls[8]?.prompt).toContain(`**${inputId}**: ${NOTE}`);

    const ready = readState(target, sessionId);
    expect(ready.reviewStatus).toBe('passed');
    expect(ready.pendingTriage).toBeUndefined();
    const built = ready.tasks.find((task) => task.title === noteFix.title);
    expect(built).toMatchObject({
      status: 'done',
      fix: { findings: [{ id: inputId, text: NOTE }] },
    });
    expect(deriveRunStatus({ state: ready, liveness: 'not-alive' }).kind).toBe('ready-to-apply');

    const replay = await readRunEvents(ref);
    expect(replay.diagnostics.skipped).toBe(0);
    const { events } = replay;
    expect(
      events.flatMap((event) =>
        event.type === 'recovery_action_selected' ? [[event.reason, event.action]] : [],
      ),
    ).toEqual([['review-failed', 'revise']]);
    expect(events.filter((event) => event.type === 'review_fix_started').at(-1)).toMatchObject({
      taskIds: [built?.id],
    });

    const transcript = transcriptText(events);
    expect(transcript).toContain('Recovery  Fix again');
    expect(transcript.match(/Recovery {2}/g)).toHaveLength(1);
    expect(transcript.split('\n').find((line) => line.includes('Recovery  Fix again'))).toContain(
      'continued',
    );
    expect(transcript).toContain(NOTE);
    expect(transcript).not.toContain('Send a correction');
  });
});
