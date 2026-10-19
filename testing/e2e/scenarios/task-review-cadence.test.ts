import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { readEvidenceLedger } from '../../../src/core/evidence/ledger-storage.js';
import {
  REVIEW_PACKET_MARKDOWN_FILE,
  SESSION_LOG_FILE,
  STATE_FILE,
  sessionsRoot,
} from '../../../src/core/paths.js';
import { groupEventsIntoSections } from '../../../src/core/sections/event-sections.js';
import { readRunRecord } from '../../../src/core/sessions/run-record-io.js';
import type { ReviewAnswer } from '../../../src/core/schemas/review.js';
import { WorkflowStateSchema } from '../../../src/core/schemas/workflow.js';
import { readRunEvents } from '../../../src/engine/events/replay.js';
import type { EngineEvent } from '../../../src/engine/events/types.js';
import { runRows } from '../../../src/features/workflow/closed/copy.js';
import { deriveSummaryView } from '../../../src/features/workflow/closed/view-model.js';
import { rowText } from '../../../src/features/workflow/conversation-rows/row-format/rows.js';
import { readStopMenuRows } from '../../../src/features/workflow/stop/options.js';
import { addEvent, reduceTasks } from '../../../src/stores/workflow/actions/event.js';
import { selectRunningBrief, tasksStore } from '../../../src/stores/workflow/tasks.js';
import { activateSafeCliShimPath } from '#testing/helpers/compatible-cli-shim.js';
import { buildConversationRows } from '#testing/helpers/event-rows.js';
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
const fix = makeTaskSpec({
  id: 'T003',
  title: 'Test the alpha value type',
  intent: 'Verify that the alpha value is a string.',
  criteria: ['C1'],
  suggestedFiles: ['src/alpha-type.test.mjs'],
  contextFiles: ['src/alpha.mjs'],
  checks: [{ id: 'T003-K1', kind: 'test', value: 'src/alpha-type.test.mjs', required: true }],
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
const findings: ReviewAnswer['findings'] = [
  {
    id: 'F1',
    kind: 'defect',
    severity: 'blocking',
    taskId: null,
    criterionId: 'C2',
    file: 'src/beta.mjs',
    line: null,
    text: 'The pending beta value is missing.',
    acceptance: null,
    checkIds: null,
  },
  {
    id: 'F2',
    kind: 'defect',
    severity: 'blocking',
    taskId: alpha.id,
    criterionId: 'C1',
    file: 'src/alpha.mjs',
    line: null,
    text: 'The alpha value has no explicit type test.',
    acceptance: 'Add a string type assertion.',
    checkIds: null,
  },
];
const scopeError =
  'Finding F1 is outside the task review scope and cannot be assigned to a fix task.';
const refusedCheck =
  'Check T003-K1 is refused: `grep -F alpha src/alpha.mjs` runs a program outside the allowlist (grep).';
const refusedTestCheck =
  'Check T003-K2 is refused: a `test` check names one test file, and `node --test src/alpha-type.test.mjs` is not one file.';
const rejectedDecision = { what: 'Exported beta as a number', why: 'A number is simpler.' };
const rejectReason = 'Criterion C2 needs beta to be the string beta; keep the string.';

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

/** The transcript the run screen replays at 160 columns, one string per row. */
function transcriptRows(events: EngineEvent[]): string[] {
  return buildConversationRows({
    sections: groupEventsIntoSections(events),
    expandedDiffs: new Set(),
    expandedActivityBatches: new Set(),
    cols: 160,
    viewportHeight: 50,
    streaming: { taskId: null, lines: [], active: false },
  }).rows.map((row) => rowText(row).trimEnd());
}

/**
 * `needsFix`: the T001 review fails with fix work whose first answer is refused. `rejectDecision`:
 * T002's first attempt reports a decision that PLAN rejects.
 */
async function runCadence(needsFix: boolean, rejectDecision = false) {
  fixture = createStopContinueFixture(() => '', { isolation: 'none' });
  const target = fixture;
  restorePath = activateSafeCliShimPath(target.tmpDir);
  const callsPath = join(target.tmpDir, 'calls.jsonl');
  const fixStatePath = join(target.tmpDir, 'fix-state.json');
  const reportedPath = join(target.tmpDir, 'decision-reported');
  const plannerPath = join(target.tmpDir, 'planner.mjs');
  const implementerPath = join(target.tmpDir, 'implementer.mjs');
  const offlinePath = join(target.tmpDir, 'offline.mjs');
  writeFileSync(
    offlinePath,
    "globalThis.fetch = async () => { throw new Error('E2E network disabled'); };\n",
  );
  vi.stubEnv('NODE_OPTIONS', `--import=${offlinePath}`);
  const passing = passingVerdict({
    kind: 'final',
    taskIds: [alpha.id, fix.id, beta.id],
    criterionIds: ['C1', 'C2'],
  });
  const invalidFix = {
    ...makeTaskSpec({
      id: 'T900',
      criteria: [],
      suggestedFiles: ['src/beta.mjs'],
      checks: [{ id: 'T900-K1', kind: 'cmd', value: 'node --version', required: true }],
    }),
    findingIds: ['F1'],
  };
  const refusedFix = {
    ...fix,
    checks: [
      { id: 'T003-K1', kind: 'cmd', value: 'grep -F alpha src/alpha.mjs', required: true },
      { id: 'T003-K2', kind: 'test', value: 'node --test src/alpha-type.test.mjs', required: true },
    ],
    findingIds: ['F2'],
  };
  writeFileSync(
    plannerPath,
    `import { appendFileSync } from 'node:fs';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString('utf8');
let kind;
let answer;
if (prompt.includes('# Task Implementation Review') || prompt.includes('# Final Implementation Review')) {
  kind = prompt.includes('# Task Implementation Review') ? 'task-review' : 'final-review';
  const ids = (label) => {
    const match = prompt.match(new RegExp('^' + label + ' (.+)$', 'm'));
    if (!match) throw new Error('Missing required ids: ' + label);
    return match[1].split(',').map((id) => id.trim());
  };
  const taskIds = ids('Task ids:');
  const criterionIds = ids('Criterion ids:');
  const passing = ${JSON.stringify(passing)};
  answer = {
    ...passing,
    tasks: taskIds.map((id) => passing.tasks.find((task) => task.id === id)),
    criteria: criterionIds.map((id) => passing.criteria.find((criterion) => criterion.id === id)),
  };
  if (${needsFix} && kind === 'task-review' && taskIds.join(',') === 'T001') {
    const repair = prompt.includes('It failed validation:');
    if (repair) kind = 'task-review-repair';
    answer.findings = ${JSON.stringify(findings)};
    answer.fixTasks = repair
      ? [${JSON.stringify({ ...fix, findingIds: ['F2'] })}]
      : [${JSON.stringify(invalidFix)}, ${JSON.stringify(refusedFix)}];
  }
} else if (prompt.includes('Confirm reported decisions')) {
  kind = 'decision-confirm';
  answer = ${JSON.stringify({ answer: { diagnosis: rejectReason, action: 'confirm', decisions: [] } })};
} else if (prompt.includes('# Plan the change')) {
  kind = 'plan';
  answer = ${JSON.stringify({ result: plan })};
} else {
  throw new Error('Unexpected prompt: ' + prompt);
}
appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ kind, prompt, answer }) + '\\n');
process.stdout.write(JSON.stringify(answer));
`,
  );
  const writes = [
    {
      task: alpha,
      files: {
        'src/alpha.mjs': "export const alpha = 'alpha';\n",
        'src/alpha.test.mjs':
          "import { strict as assert } from 'node:assert';\nimport { alpha } from './alpha.mjs';\nassert.equal(alpha, 'alpha');\n",
      },
    },
    {
      task: beta,
      files: {
        'src/beta.mjs': "export const beta = 'beta';\n",
        'src/beta.test.mjs':
          "import { strict as assert } from 'node:assert';\nimport { beta } from './beta.mjs';\nassert.equal(beta, 'beta');\n",
      },
    },
    {
      task: fix,
      files: {
        'src/alpha-type.test.mjs':
          "import { strict as assert } from 'node:assert';\nimport { alpha } from './alpha.mjs';\nassert.equal(typeof alpha, 'string');\n",
      },
    },
  ];
  writeFileSync(
    implementerPath,
    `import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString('utf8');
const title = prompt.match(/^## Task: (.+)$/m)?.[1];
const entry = ${JSON.stringify(writes)}.find((entry) => entry.task.title === title);
if (!entry) throw new Error('Unexpected brief: ' + prompt);
if (entry.task.id === 'T003') {
  const root = ${JSON.stringify(sessionsRoot(target.projectDir))};
  const sessions = readdirSync(root);
  if (sessions.length !== 1) throw new Error('Expected one session');
  copyFileSync(join(root, sessions[0], ${JSON.stringify(STATE_FILE)}), ${JSON.stringify(fixStatePath)});
}
appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ kind: 'implement', taskId: entry.task.id }) + '\\n');
const reports =
  ${rejectDecision} && entry.task.id === 'T002' && !existsSync(${JSON.stringify(reportedPath)});
const files = reports ? { ...entry.files, 'src/beta.mjs': 'export const beta = 2;\\n' } : entry.files;
for (const [file, source] of Object.entries(files)) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, source);
}
console.log('Implemented ' + entry.task.id);
if (reports) {
  writeFileSync(${JSON.stringify(reportedPath)}, '');
  console.log(JSON.stringify({
    status: 'done',
    filesChanged: Object.keys(entry.files),
    touchedNotSuggested: [],
    notes: null,
    decisions: [${JSON.stringify(rejectedDecision)}],
  }));
}
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
  expect(run.exitCode, `${run.stdout}\n${run.stderr}`).toBe(0);
  const sessions = readdirSync(sessionsRoot(target.projectDir));
  expect(sessions).toHaveLength(1);
  const sessionId = sessions[0];
  if (sessionId === undefined) throw new Error('Missing session');
  const state = readState(target, sessionId);
  expect(state.phase).toBe('complete');
  expect(state.tasks.every((task) => task.status === 'done')).toBe(true);
  const replay = await readRunEvents({ projectDir: target.projectDir, sessionId });
  expect(replay.diagnostics.skipped).toBe(0);
  expect(
    readFileSync(join(sessionsRoot(target.projectDir), sessionId, SESSION_LOG_FILE), 'utf8'),
  ).not.toBe('');
  const calls: Array<{ kind: string; taskId?: string; prompt?: string; answer?: ReviewAnswer }> =
    readFileSync(callsPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
  return { state, events: replay.events, calls, fixStatePath, target, sessionId };
}

describe('e2e: task review cadence', () => {
  it('rejects pending-task fix work and replays the inserted fix before the pending brief', async () => {
    const { state, events, calls, fixStatePath, target, sessionId } = await runCadence(true);
    expect(calls.map((call) => call.kind)).toEqual([
      'plan',
      'implement',
      'task-review',
      'task-review-repair',
      'implement',
      'task-review',
      'implement',
      'task-review',
      'final-review',
    ]);
    expect(calls.filter((call) => call.kind === 'implement').map((call) => call.taskId)).toEqual([
      'T001',
      'T003',
      'T002',
    ]);
    const repair = calls.find((call) => call.kind === 'task-review-repair');
    expect(repair?.prompt).toContain(scopeError);
    // A fix check the plan command policy refuses goes back to the reviewer and never becomes a
    // required check of the fix brief.
    expect(repair?.prompt).toContain(refusedCheck);
    expect(repair?.prompt).toContain(refusedTestCheck);
    expect(JSON.stringify(state.tasks)).not.toContain('grep');
    const fixes = state.tasks.filter((task) => task.fix !== undefined);
    expect(fixes).toHaveLength(1);
    expect(fixes[0]).toMatchObject({
      id: 'T003',
      criteria: ['C1'],
      fix: { findings: [{ id: 'F2' }] },
    });
    expect(
      state.tasks.filter((task) => task.criteria?.includes('C2')).map((task) => task.id),
    ).toEqual(['T002']);
    expect(
      state.tasks.flatMap((task) => task.fix?.findings.map((finding) => finding.id) ?? []),
    ).not.toContain('F1');
    const order = ['T001', 'T003', 'T002'];
    expect(state.tasks.map((task) => task.id)).toEqual(order);
    const runningState = WorkflowStateSchema.parse(JSON.parse(readFileSync(fixStatePath, 'utf8')));
    expect(runningState.tasks.map((task) => task.id)).toEqual(order);
    expect(runningState.tasks[runningState.currentTaskIndex]).toMatchObject({
      id: 'T003',
      status: 'in_progress',
    });
    expect(runningState.tasks.find((task) => task.id === 'T002')?.status).toBe('pending');
    const announcementIndex = events.findIndex(
      (event) => event.type === 'tasks_planned' && event.total === 3,
    );
    const fixCycleIndex = events.findIndex((event) => event.type === 'review_fix_started');
    const fixStartIndex = events.findIndex(
      (event) => event.type === 'task_started' && event.taskId === 'T003',
    );
    expect(announcementIndex).toBeGreaterThan(-1);
    expect(events[announcementIndex]).toMatchObject({
      tasks: order.map((id, index) => ({ id, index })),
    });
    expect(fixCycleIndex).toBeGreaterThan(announcementIndex);
    expect(fixStartIndex).toBeGreaterThan(fixCycleIndex);
    expect(
      events.filter((event) => event.type === 'task_started').map((event) => event.taskId),
    ).toEqual(order);
    expect(
      events.find((event) => event.type === 'review_completed' && event.afterTaskId === 'T001'),
    ).toMatchObject({
      scope: 'task',
      verdict: 'fail',
      findings: { blocking: 1, minor: 0, outOfScope: 1 },
    });
    expect(
      events
        .filter((event) => event.type === 'review_started' || event.type === 'review_completed')
        .map((event) => ({ type: event.type, scope: event.scope, afterTaskId: event.afterTaskId })),
    ).toEqual(
      ['T001', 'T003', 'T002', undefined].flatMap((afterTaskId) =>
        ['review_started', 'review_completed'].map((type) => ({
          type,
          scope: afterTaskId === undefined ? 'final' : 'task',
          afterTaskId,
        })),
      ),
    );
    const failedReview = events.find(
      (event) => event.type === 'review_completed' && event.afterTaskId === 'T001',
    );
    expect(failedReview).toMatchObject({
      blockingFindings: [{ id: 'F2', text: findings[1]?.text }],
    });
    // The finding that failed the task review is on screen, in the section of that review.
    const rows = transcriptRows(events);
    const findingRow = rows.findIndex((row) => row.includes('Blocking F2'));
    expect(rows[findingRow]).toMatch(/Blocking F2 +The alpha value has no explicit type test\.$/);
    const heading = rows.findIndex((row) => row.trim() === 'Review T001');
    expect(heading).toBeGreaterThan(-1);
    expect(findingRow).toBeGreaterThan(heading);
    // The failed task review stays in the evidence trail after the final review passes.
    const reviews = readEvidenceLedger({ projectDir: target.projectDir, sessionId })?.reviews;
    expect(reviews?.map((review) => [review.scope, review.afterTaskId, review.outcome])).toEqual([
      ['task', 'T001', 'fail'],
      ['task', 'T003', 'pass'],
      ['task', 'T002', 'pass'],
      ['final', undefined, 'pass'],
    ]);
    expect(reviews?.[0]).toMatchObject({
      cycle: 0,
      blocking: [{ id: 'F2', text: findings[1]?.text }],
    });
    const packet = readFileSync(
      join(sessionsRoot(target.projectDir), sessionId, REVIEW_PACKET_MARKDOWN_FILE),
      'utf8',
    );
    expect(packet).toContain(
      `- Task review after T001, fix cycle 0: fail\n  - F2: ${findings[1]?.text}\n`,
    );
    const closed = deriveSummaryView({
      record: readRunRecord({ projectDir: target.projectDir, sessionId }),
    });
    expect(closed?.failedReviews).toEqual([
      { label: 'Review T001', blocking: [{ id: 'F2', text: findings[1]?.text }] },
    ]);
    expect(closed === null ? [] : runRows(closed).map((row) => row.segments)).toContainEqual([
      { text: `  F2 ${findings[1]?.text}`, tone: 'textDim' },
    ]);
    const initial = tasksStore.get();
    const running = events.slice(0, fixStartIndex + 1).reduce(reduceTasks, initial);
    expect(running.tasks.map((task) => task.id)).toEqual(order);
    expect(running.currentTask).toBe(2);
    expect(selectRunningBrief(running, 'implementing')).toMatchObject({
      current: { id: 'T003', title: fix.title, status: 'in_progress' },
      next: { id: 'T002', title: beta.title, status: 'pending' },
    });
    for (const event of events.slice(0, fixStartIndex + 1)) addEvent(event);
    expect(readStopMenuRows().find((row) => row.id === 'pause-after-brief')?.consequence).toBe(
      'finish T003 including checks and review; do not start T002',
    );
    const completed = events.reduce(reduceTasks, initial);
    expect(
      completed.tasks.map((task) => ({ id: task.id, title: task.title, status: task.status })),
    ).toEqual(state.tasks.map((task) => ({ id: task.id, title: task.title, status: task.status })));
  });

  it('sends the brief back to BUILD with the reason when PLAN rejects the decisions it reported', async () => {
    const { state, events, calls, target } = await runCadence(false, true);
    expect(calls.map((call) => call.kind)).toEqual([
      'plan',
      'implement',
      'task-review',
      'implement',
      'decision-confirm',
      'implement',
      'task-review',
      'final-review',
    ]);
    expect(events.find((event) => event.type === 'consult_answered')).toMatchObject({
      taskId: 'T002',
      reason: 'deviation',
      action: 'confirm',
      decisionCount: 0,
      rejectedCount: 1,
      diagnosis: rejectReason,
    });
    const retry = events.find((event) => event.type === 'task_retry');
    expect(retry).toMatchObject({ taskId: 'T002' });
    expect(retry?.type === 'task_retry' ? retry.error : '').toContain(rejectReason);
    expect(transcriptRows(events)).toContainEqual(
      expect.stringContaining(`PLAN rejected 1 decision for T002 · ${rejectReason}`),
    );
    expect(state.plan?.decisions.map((decision) => decision.text).join('\n')).not.toContain(
      rejectedDecision.what,
    );
    expect(readFileSync(join(target.projectDir, 'src/beta.mjs'), 'utf8')).toBe(
      "export const beta = 'beta';\n",
    );
  });

  it('records task review pairs between briefs and the final pair before workflow completion', async () => {
    const { state, events, calls } = await runCadence(false);
    expect(calls.map((call) => call.kind)).toEqual([
      'plan',
      'implement',
      'task-review',
      'implement',
      'task-review',
      'final-review',
    ]);
    expect(state.tasks.map((task) => task.id)).toEqual(['T001', 'T002']);
    const timeline = events.filter((event) =>
      [
        'task_started',
        'task_completed',
        'review_started',
        'review_completed',
        'workflow_complete',
      ].includes(event.type),
    );
    expect(timeline).toMatchObject([
      { type: 'task_started', taskId: 'T001' },
      { type: 'task_completed', taskId: 'T001' },
      { type: 'review_started', scope: 'task', afterTaskId: 'T001' },
      { type: 'review_completed', scope: 'task', afterTaskId: 'T001', verdict: 'pass' },
      { type: 'task_started', taskId: 'T002' },
      { type: 'task_completed', taskId: 'T002' },
      { type: 'review_started', scope: 'task', afterTaskId: 'T002' },
      { type: 'review_completed', scope: 'task', afterTaskId: 'T002', verdict: 'pass' },
      { type: 'review_started', scope: 'final' },
      { type: 'review_completed', scope: 'final', verdict: 'pass' },
      { type: 'workflow_complete', review: 'passed' },
    ]);
    for (const event of timeline) {
      if (
        (event.type === 'review_started' || event.type === 'review_completed') &&
        event.scope === 'final'
      ) {
        expect(event).not.toHaveProperty('afterTaskId');
      }
    }
  });
});
