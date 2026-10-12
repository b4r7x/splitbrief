import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { sessionsRoot } from '../../../src/core/paths.js';
import type { ReviewAnswer } from '../../../src/core/schemas/review.js';
import { readRunEvents } from '../../../src/engine/events/replay.js';
import { rowText } from '../../../src/features/workflow/conversation-rows/row-format/rows.js';
import type { StreamingOutputState } from '../../../src/stores/workflow/streaming-output.js';
import { activateSafeCliShimPath } from '#testing/helpers/compatible-cli-shim.js';
import { eventRows } from '#testing/helpers/event-rows.js';
import { makePlanProposal, makeTaskSpec } from '#testing/helpers/factories/plan.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import {
  cli,
  createStopContinueFixture,
  readState,
  type StopContinueFixture,
} from '../helpers/stop-continue-fixture.js';

const RUN_TIMEOUT_MS = 150_000;
const HINT = 'consult-hint-review-seat';
const INSTRUCTIONS = `Export fixed as ${HINT}`;
const DIAGNOSIS = 'The fix exports a placeholder instead of the value the finding asks for.';
const GUIDANCE_MARKER = '## Guidance from the reviewer:\n';
const GREET_SOURCE = "export const greet = (name) => 'hello ' + name;\n";
const GREET_TEST_SOURCE =
  "import { greet } from './greet.mjs';\nif (greet('a') !== 'hello a') process.exit(1);\n";
const FIX_TEST_SOURCE = `import { fixed } from './fix.mjs';\nif (fixed !== ${JSON.stringify(HINT)}) process.exit(1);\n`;

const greet = makeTaskSpec({
  id: 'T001',
  title: 'Add the greeting',
  intent: 'Return a greeting for a name.',
  criteria: ['C1'],
  suggestedFiles: ['src/greet.mjs', 'src/greet.test.mjs'],
  checks: [{ id: 'T001-K1', kind: 'test', value: 'src/greet.test.mjs', required: true }],
});
const fix = makeTaskSpec({
  id: 'T002',
  title: 'Export the fixed value',
  intent: 'Export the fixed value the review asks for.',
  criteria: ['C1'],
  suggestedFiles: ['src/fix.mjs', 'src/fix.test.mjs'],
  contextFiles: ['src/greet.mjs'],
  checks: [{ id: 'T002-K1', kind: 'test', value: 'src/fix.test.mjs', required: true }],
});
const plan = makePlanProposal({
  summary: 'Add a tested greeting.',
  decisions: [],
  criteria: [{ id: 'C1', text: 'A name gets a greeting.', checkIds: ['T001-K1'] }],
  tasks: [greet],
});
const findings: ReviewAnswer['findings'] = [
  {
    id: 'F1',
    kind: 'defect',
    severity: 'blocking',
    taskId: greet.id,
    criterionId: 'C1',
    file: 'src/greet.mjs',
    line: null,
    text: 'The greeting has no exported fixed value.',
    acceptance: 'Export the fixed value.',
    checkIds: null,
  },
];
const consultAnswer = {
  answer: { diagnosis: DIAGNOSIS, action: 'guidance', instructions: INSTRUCTIONS, context: null },
};
const streaming: StreamingOutputState = { taskId: null, lines: [], active: false };

type Call = Readonly<{ seat: string; kind: string; taskId?: string; prompt: string }>;

let fixture: StopContinueFixture | undefined;
let restorePath: (() => void) | undefined;

afterEach(() => {
  restorePath?.();
  vi.unstubAllEnvs();
  if (fixture !== undefined) cleanupTempDir(fixture.tmpDir);
  fixture = undefined;
  restorePath = undefined;
});

function plannerScript(callsPath: string): string {
  return `import { appendFileSync } from 'node:fs';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString('utf8');
const kind = /^# Plan the change$/m.test(prompt)
  ? 'plan'
  : /^# Consult on a failing task$/m.test(prompt)
    ? 'consult'
    : 'other';
appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ seat: 'planner', kind, prompt }) + '\\n');
if (kind !== 'plan') process.exit(1);
process.stdout.write(${JSON.stringify(JSON.stringify({ result: plan }))});
`;
}

function reviewerScript(callsPath: string): string {
  return `import { appendFileSync } from 'node:fs';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString('utf8');
const ids = (label) => {
  const match = prompt.match(new RegExp('^' + label + ' (.+)$', 'm'));
  if (!match) throw new Error('Missing required ids: ' + label);
  return match[1].split(',').map((id) => id.trim()).filter((id) => id !== '' && id !== 'none');
};
const passing = () => ({
  tasks: ids('Task ids:').map((id) => ({ id, plan: 'met', note: '' })),
  criteria: ids('Criterion ids:').map((id) => ({ id, status: 'pass', evidence: '' })),
  findings: [],
  fixTasks: [],
  rejected: [],
  verify: [],
  ask: null,
});
let kind;
let answer;
if (/^# Consult on a failing task$/m.test(prompt)) {
  kind = 'consult';
  answer = ${JSON.stringify(consultAnswer)};
} else if (/^# Task Implementation Review$/m.test(prompt)) {
  kind = 'task-review';
  answer = passing();
  if (ids('Task ids:').join(',') === 'T001') {
    answer.findings = ${JSON.stringify(findings)};
    answer.fixTasks = [${JSON.stringify({ ...fix, findingIds: ['F1'] })}];
  }
} else if (/^# Final Implementation Review$/m.test(prompt)) {
  kind = 'final-review';
  answer = passing();
} else {
  kind = 'other';
}
appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ seat: 'reviewer', kind, prompt }) + '\\n');
if (kind === 'other') process.exit(1);
process.stdout.write(JSON.stringify(answer));
`;
}

/**
 * T001 writes a passing greeting. T002 writes a placeholder its own test rejects, a different
 * one per attempt, until its prompt carries the reviewer's guidance: then it exports the value
 * the guidance names, read from the first line under the guidance heading.
 */
function implementerScript(callsPath: string): string {
  return `import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString('utf8');
const title = prompt.match(/^## Task: (.+)$/m)?.[1];
const taskId = { ${JSON.stringify(greet.title)}: 'T001', ${JSON.stringify(fix.title)}: 'T002' }[title];
if (taskId === undefined) throw new Error('Unexpected brief: ' + prompt);
const callsPath = ${JSON.stringify(callsPath)};
const earlier = existsSync(callsPath)
  ? readFileSync(callsPath, 'utf8')
      .trim()
      .split('\\n')
      .map((line) => JSON.parse(line))
      .filter((call) => call.seat === 'implementer' && call.taskId === taskId).length
  : 0;
appendFileSync(callsPath, JSON.stringify({ seat: 'implementer', kind: 'implement', taskId, prompt }) + '\\n');
mkdirSync('src', { recursive: true });
if (taskId === 'T001') {
  writeFileSync('src/greet.mjs', ${JSON.stringify(GREET_SOURCE)});
  writeFileSync('src/greet.test.mjs', ${JSON.stringify(GREET_TEST_SOURCE)});
} else {
  const marker = ${JSON.stringify(GUIDANCE_MARKER)};
  const at = prompt.indexOf(marker);
  const value =
    at < 0 ? 'broken-' + (earlier + 1) : prompt.slice(at + marker.length).split('\\n')[0].split(' ').at(-1);
  writeFileSync('src/fix.mjs', 'export const fixed = ' + JSON.stringify(value) + ';\\n');
  writeFileSync('src/fix.test.mjs', ${JSON.stringify(FIX_TEST_SOURCE)});
}
console.log('Implemented ' + taskId);
`;
}

describe('e2e: fix task repair consult', { timeout: 240_000 }, () => {
  it('consults the review seat for a twice-failing fix task and delivers its guidance to the next attempt', async () => {
    fixture = createStopContinueFixture(() => '', { isolation: 'none' });
    const target = fixture;
    restorePath = activateSafeCliShimPath(target.tmpDir);
    const callsPath = join(target.tmpDir, 'calls.jsonl');
    const plannerPath = join(target.tmpDir, 'planner.mjs');
    const reviewerPath = join(target.tmpDir, 'reviewer.mjs');
    const implementerPath = join(target.tmpDir, 'implementer.mjs');
    const offlinePath = join(target.tmpDir, 'offline.mjs');
    writeFileSync(
      offlinePath,
      "globalThis.fetch = async () => { throw new Error('E2E network disabled'); };\n",
    );
    vi.stubEnv('NODE_OPTIONS', `--import=${offlinePath}`);
    writeFileSync(plannerPath, plannerScript(callsPath));
    writeFileSync(reviewerPath, reviewerScript(callsPath));
    writeFileSync(implementerPath, implementerScript(callsPath));
    const config = loadConfig(target.projectDir).config;
    if (config.planner.kind !== 'shell' || config.implementer.kind !== 'agent') {
      throw new Error('Expected local shell and agent fixture runners');
    }
    writeConfig(target.projectDir, {
      ...config,
      planner: { ...config.planner, args: [plannerPath] },
      reviewer: {
        kind: 'shell',
        command: 'node',
        args: [reviewerPath],
        outputFormat: 'text',
        capabilities: { supportsConversationalPlanning: false, supportsSessionResume: false },
      },
      implementer: { ...config.implementer, args: [implementerPath] },
      workflow: { ...config.workflow, review: 'task', approve: 'none' },
      validation: { ...config.validation, testCommand: 'node --test' },
    });

    const run = await cli(target, ['start', 'smoke'], { timeoutMs: RUN_TIMEOUT_MS });
    expect(run.exitCode, `${run.stdout}\n${run.stderr}`).toBe(0);

    const calls: Call[] = readFileSync(callsPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(calls.map((call) => `${call.seat}:${call.kind}${call.taskId ?? ''}`)).toEqual([
      'planner:plan',
      'implementer:implementT001',
      'reviewer:task-review',
      'implementer:implementT002',
      'implementer:implementT002',
      'reviewer:consult',
      'implementer:implementT002',
      'reviewer:task-review',
      'reviewer:final-review',
    ]);
    expect(calls.filter((call) => call.seat === 'planner').map((call) => call.kind)).toEqual([
      'plan',
    ]);

    const consult = calls.find((call) => call.kind === 'consult');
    expect(consult?.prompt).toContain(
      "You are the run's reviewer: you wrote this fix task at the review, and you decide its repair.",
    );
    expect(consult?.prompt).toContain('## Task T002 (revision 1)');
    expect(consult?.prompt).toContain('failed — The task failed');

    const fixPrompts = calls
      .filter((call) => call.seat === 'implementer' && call.taskId === 'T002')
      .map((call) => call.prompt);
    expect(fixPrompts).toHaveLength(3);
    for (const prompt of fixPrompts.slice(0, 2)) expect(prompt).not.toContain(GUIDANCE_MARKER);
    expect(fixPrompts[2]).toContain(`${GUIDANCE_MARKER}${INSTRUCTIONS}`);
    expect(readFileSync(join(target.projectDir, 'src/fix.mjs'), 'utf8')).toBe(
      `export const fixed = ${JSON.stringify(HINT)};\n`,
    );

    const sessions = readdirSync(sessionsRoot(target.projectDir));
    expect(sessions).toHaveLength(1);
    const sessionId = sessions[0];
    if (sessionId === undefined) throw new Error('Missing session');
    const state = readState(target, sessionId);
    expect(state.phase).toBe('complete');
    expect(state.tasks.map((task) => ({ id: task.id, status: task.status }))).toEqual([
      { id: 'T001', status: 'done' },
      { id: 'T002', status: 'done' },
    ]);
    expect(state.tasks.find((task) => task.id === 'T002')).toMatchObject({
      fix: { findings: [{ id: 'F1' }] },
    });
    const records = Object.values(state.lineages ?? {}).flatMap(
      (lineage) => lineage.consultRecords,
    );
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      taskId: 'T002',
      reason: 'failed',
      action: 'guidance',
      diagnosis: DIAGNOSIS,
      seat: 'review',
    });

    const replay = await readRunEvents({ projectDir: target.projectDir, sessionId });
    expect(replay.diagnostics.skipped).toBe(0);
    const events = replay.events;
    expect(events.find((event) => event.type === 'review_fix_started')).toMatchObject({
      taskIds: ['T002'],
    });
    const answered = events.filter((event) => event.type === 'consult_answered');
    expect(answered).toHaveLength(1);
    expect(answered[0]).toMatchObject({
      taskId: 'T002',
      reason: 'failed',
      seat: 'review',
      action: 'guidance',
      diagnosis: DIAGNOSIS,
      newTaskIds: null,
    });
    const retryIndexes = events.flatMap((event, index) =>
      event.type === 'task_retry' && event.taskId === 'T002' ? [index] : [],
    );
    expect(retryIndexes).toHaveLength(1);
    const escalatingIndex = events.findIndex(
      (event) => event.type === 'task_escalating' && event.taskId === 'T002',
    );
    const answeredIndex = events.findIndex((event) => event.type === 'consult_answered');
    const completedIndex = events.findIndex(
      (event) => event.type === 'task_completed' && event.taskId === 'T002',
    );
    expect(retryIndexes[0]).toBeLessThan(escalatingIndex);
    expect(escalatingIndex).toBeLessThan(answeredIndex);
    expect(answeredIndex).toBeLessThan(completedIndex);
    expect(events[completedIndex]).toMatchObject({ method: 'consulted' });
    expect(events.find((event) => event.type === 'workflow_complete')).toMatchObject({
      review: 'passed',
    });

    const consultEvent = answered[0];
    if (consultEvent === undefined) throw new Error('Missing consult_answered event');
    const rows = eventRows({
      event: consultEvent,
      globalIndex: 0,
      expanded: false,
      ctx: { width: 120, viewportRows: 20, streaming },
    });
    expect(rows.flatMap((row) => row.segments)).toContainEqual({
      text: 'REVIEW',
      tone: 'reviewer',
    });
    const transcript = rows.map(rowText).join('\n');
    expect(transcript).toContain('T002');
    expect(transcript).toContain('guidance');
    expect(transcript).toContain(DIAGNOSIS);
    expect(transcript).not.toContain('PLAN');
  });
});
