import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { plainUserMessage } from '../../../src/core/types/user-input.js';
import type { PlannerConversation } from '../../../src/core/schemas/workflow.js';
import { groupEventsIntoSections } from '../../../src/core/sections/event-sections.js';
import { readRunRecord } from '../../../src/core/sessions/run-record-io.js';
import { readRunEvents } from '../../../src/engine/events/replay.js';
import { rowText } from '../../../src/features/workflow/conversation-rows/row-format/rows.js';
import { deriveSummaryView } from '../../../src/features/workflow/closed/view-model.js';
import { hydrateRun } from '../../../src/features/workflow/run-history.js';
import { stopByline } from '../../../src/features/workflow/stop/copy.js';
import { eventsStore } from '../../../src/stores/workflow/events.js';
import { buildConversationRows } from '#testing/helpers/event-rows.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import {
  applyRun,
  cli,
  continueAndSignal,
  continueRun,
  continueWithCorrection,
  createStopContinueFixture,
  endImplementerHold,
  GREET_FILE,
  GREET_SOURCE,
  MARKER_FILE,
  MARKER_SOURCE,
  readState,
  startAndSignal,
  type StopContinueFixture,
} from '../helpers/stop-continue-fixture.js';

let fixture: StopContinueFixture | undefined;

afterEach(async () => {
  if (fixture !== undefined) {
    await endImplementerHold(fixture);
    cleanupTempDir(fixture.tmpDir);
  }
  fixture = undefined;
  resetAllStores();
});

/**
 * What one implementer invocation does: the files it writes, the report it prints, how long it
 * works, then whether it holds for a stop.
 */
type ImplementerCall = Readonly<{
  writes?: Readonly<Record<string, string>>;
  report?: Readonly<Record<string, unknown>>;
  worksMs?: number;
  holds?: true;
}>;

const BOTH_FILES = { [GREET_FILE]: GREET_SOURCE, [MARKER_FILE]: MARKER_SOURCE };

/** The report a call prints when it ends with nothing left to change. */
const IDLE_REPORT = {
  status: 'done',
  filesChanged: [],
  touchedNotSuggested: [],
  notes: null,
  decisions: [],
};

/** A greet the corrected call writes over the kept one. */
const TRIMMED_GREET_SOURCE = `export function greet(name: string): string {
  const trimmed = name.trim();
  return trimmed === '' ? 'hello' : \`hello \${trimmed}\`;
}`;

/**
 * Invocation n does `calls[n]`: it saves its prompt, writes its files and, when it holds, signals
 * under `signal/<n>/` (outside the project, so a call that writes nothing can be stopped too) and
 * waits for the stop. An invocation past the list is a retry: it writes both files.
 */
function implementerCalls(calls: readonly ImplementerCall[]): (projectDir: string) => string {
  return (projectDir) => {
    const tmpDir = join(projectDir, '..');
    return `import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);

const countPath = ${JSON.stringify(join(tmpDir, 'implementer-invocations'))};
let invocations = 0;
try {
  invocations = Number(readFileSync(countPath, 'utf8')) || 0;
} catch {}
writeFileSync(countPath, String(invocations + 1));
writeFileSync(join(${JSON.stringify(tmpDir)}, 'prompt-' + invocations), Buffer.concat(chunks));

const call = ${JSON.stringify(calls)}[invocations] ?? { writes: ${JSON.stringify(BOTH_FILES)} };
for (const [file, text] of Object.entries(call.writes ?? {})) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}
if (call.report) process.stdout.write(JSON.stringify(call.report));
if (call.worksMs) await delay(call.worksMs);
if (call.holds) {
  writeFileSync(${JSON.stringify(join(tmpDir, 'implementer-hold.pid'))}, String(process.pid));
  const signalPath = join(${JSON.stringify(join(tmpDir, 'signal'))}, String(invocations), ${JSON.stringify(MARKER_FILE)});
  mkdirSync(dirname(signalPath), { recursive: true });
  writeFileSync(signalPath, '');
  const deadline = Date.now() + 180000;
  while (!existsSync(${JSON.stringify(join(tmpDir, 'release-implementer'))}) && Date.now() < deadline) await delay(50);
  writeFileSync(${JSON.stringify(join(tmpDir, 'implementer-hold-exited'))}, '');
}
`;
  };
}

/** Where invocation n signals that it holds. */
function signalDir(target: StopContinueFixture, invocation: number): string {
  return join(target.tmpDir, 'signal', String(invocation));
}

function invocations(target: StopContinueFixture): number {
  return Number(readFileSync(join(target.tmpDir, 'implementer-invocations'), 'utf8'));
}

function prompt(target: StopContinueFixture, invocation: number): string {
  return readFileSync(join(target.tmpDir, `prompt-${invocation}`), 'utf8');
}

async function retries(target: StopContinueFixture, sessionId: string): Promise<string[]> {
  const { events } = await readRunEvents({ projectDir: target.projectDir, sessionId });
  return events.flatMap((event) => (event.type === 'task_retry' ? [event.error] : []));
}

/** Ends the run from the shell and returns the patch it saved. */
async function endRunPatch(target: StopContinueFixture, sessionId: string): Promise<string> {
  const ended = await cli(target, ['continue', sessionId, '--action', 'end-run']);
  expect(ended.exitCode, ended.stderr).toBe(0);
  const closed = readState(target, sessionId).closed;
  if (closed?.patch === undefined) throw new Error('the ended run has no patch');
  return readFileSync(join(target.projectDir, closed.patch), 'utf8');
}

/** The run's transcript as the run screen replays it at `cols` columns, one string per row. */
async function transcriptRows(
  target: StopContinueFixture,
  sessionId: string,
  cols: number,
): Promise<string[]> {
  await hydrateRun(readRunRecord({ projectDir: target.projectDir, sessionId }));
  return buildConversationRows({
    sections: groupEventsIntoSections(eventsStore.get().events),
    expandedDiffs: new Set(),
    expandedActivityBatches: new Set(),
    cols,
    viewportHeight: 50,
    streaming: { taskId: null, lines: [], active: false },
  }).rows.map((row) => rowText(row).trimEnd());
}

/** The rows after the run continued, at 120 and at 200 columns: the resumed brief's own rows. */
async function resumedRows(target: StopContinueFixture, sessionId: string): Promise<string[][]> {
  return Promise.all(
    [120, 200].map(async (cols) => {
      const rows = await transcriptRows(target, sessionId, cols);
      return rows.slice(rows.indexOf('Run continued'));
    }),
  );
}

/** What the stopped byline says once the stop settled the run at rest on its re-read record. */
function settledStopLead(target: StopContinueFixture, sessionId: string): string {
  const byline = stopByline({
    intent: 'stop-now',
    phase: 'parked',
    workflowPhase: 'implementing',
    parked: { kind: 'mid-brief', taskId: null, kept: [] },
    currentTaskId: null,
    nextTaskId: null,
    passed: 0,
    total: 1,
    elapsedMs: 0,
    questionPending: false,
    suite: null,
    record: readRunRecord({ projectDir: target.projectDir, sessionId }),
  });
  return byline?.parts.map((part) => part.text).join('') ?? '';
}

const KEPT_GREET = '+export function greet(name: string): string {';
const KEPT_MARKER = "+export const RUN_MARKER = 'implementer-started';";

describe('stop after the brief wrote its files → continue', { timeout: 240_000 }, () => {
  it('passes the brief on the kept work when the resumed call changes nothing', async () => {
    fixture = createStopContinueFixture(
      implementerCalls([
        { writes: BOTH_FILES, worksMs: 1_000, holds: true },
        { report: { ...IDLE_REPORT, filesChanged: [MARKER_FILE] } },
      ]),
    );
    const target = fixture;

    const parked = await startAndSignal(target, 'SIGINT', signalDir(target, 0));
    expect(parked.exitCode).toBe(0);
    expect(readState(target, parked.sessionId).interruptedStep?.kept).toEqual([
      GREET_FILE,
      MARKER_FILE,
    ]);
    expect(settledStopLead(target, parked.sessionId)).toBe(
      'Stopped at T001 · Partial changes kept',
    );

    const resumed = await continueRun(target);
    expect(resumed.exitCode, resumed.stderr).toBe(0);
    expect(resumed.stdout).toContain('task T001: done (no checks)');
    expect(invocations(target)).toBe(2);
    expect(await retries(target, parked.sessionId)).toEqual([]);
    // The implementer's own report names one of the two files the brief holds. The call's row is
    // the one list: it names them both, says this call kept them rather than wrote them, and
    // carries no call time beside the brief's own.
    for (const rows of await resumedRows(target, parked.sessionId)) {
      const report = rows.indexOf('Report  done · 0 decisions');
      expect(report).toBeGreaterThan(0);
      expect(rows.slice(report + 1, report + 4)).toEqual([
        '',
        'src/greet.ts · src/marker.ts',
        "verified · kept the interrupted attempt's work · no further change",
      ]);
      expect(rows.join('\n')).not.toContain('no change needed');
    }

    // The brief's time is the stretch it worked before the stop plus the one after Continue; the
    // time the run sat stopped is left out. The transcript and the closed run show that one time.
    const { events } = await readRunEvents({
      projectDir: target.projectDir,
      sessionId: parked.sessionId,
    });
    const starts = events.flatMap((event) => (event.type === 'task_started' ? [event.ts] : []));
    const stop = events.find((event) => event.type === 'turn_interrupted');
    const done = events.find((event) => event.type === 'task_completed');
    const [firstStart, secondStart] = starts;
    if (
      firstStart === undefined ||
      secondStart === undefined ||
      stop === undefined ||
      done?.type !== 'task_completed'
    ) {
      throw new Error('expected a brief stopped once and completed after Continue');
    }
    const worked = stop.ts - firstStart + (done.ts - secondStart);
    expect(done.duration).toBeGreaterThanOrEqual(worked - 200);
    expect(done.duration).toBeLessThan(done.ts - firstStart);
    await hydrateRun(readRunRecord({ projectDir: target.projectDir, sessionId: parked.sessionId }));
    const brief = groupEventsIntoSections(eventsStore.get().events).find(
      (section) => section.type === 'completed-task',
    );
    expect(brief?.type === 'completed-task' && brief.summary.duration).toBe(done.duration);

    const patch = await endRunPatch(target, parked.sessionId);
    expect(patch).toContain(KEPT_GREET);
    expect(patch).toContain(KEPT_MARKER);
    const closed = deriveSummaryView({
      record: readRunRecord({ projectDir: target.projectDir, sessionId: parked.sessionId }),
    });
    expect(closed?.briefs.rows.map((row) => [row.id, row.durationMs])).toEqual([
      ['T001', done.duration],
    ]);
  });

  it('passes the brief on the kept work when a typed correction needs no change', async () => {
    fixture = createStopContinueFixture(
      implementerCalls([{ writes: BOTH_FILES, holds: true }, {}]),
    );
    const target = fixture;
    const correction = 'The two files look right. Keep them as they are.';

    const parked = await startAndSignal(target, 'SIGINT', signalDir(target, 0));
    expect(parked.exitCode).toBe(0);

    const resumed = await continueWithCorrection(target, parked.sessionId, correction);
    expect(resumed.tasks).toMatchObject([{ id: 'T001', status: 'done' }]);
    expect(invocations(target)).toBe(2);
    expect(prompt(target, 1)).toContain(correction);
    expect(await retries(target, parked.sessionId)).toEqual([]);

    const patch = await endRunPatch(target, parked.sessionId);
    expect(patch).toContain(KEPT_GREET);
    expect(patch).toContain(KEPT_MARKER);
  });

  it('keeps the work a typed correction changes on resume', async () => {
    fixture = createStopContinueFixture(
      implementerCalls([
        { writes: BOTH_FILES, holds: true },
        { writes: { [GREET_FILE]: TRIMMED_GREET_SOURCE } },
      ]),
    );
    const target = fixture;
    const correction = 'Trim the name before the greeting.';

    const parked = await startAndSignal(target, 'SIGINT', signalDir(target, 0));
    expect(parked.exitCode).toBe(0);

    const resumed = await continueWithCorrection(target, parked.sessionId, correction);
    expect(resumed.tasks).toMatchObject([{ id: 'T001', status: 'done' }]);
    expect(invocations(target)).toBe(2);
    expect(prompt(target, 1)).toContain(correction);
    expect(await retries(target, parked.sessionId)).toEqual([]);

    const patch = await endRunPatch(target, parked.sessionId);
    expect(patch).toContain('+  const trimmed = name.trim();');
    expect(patch).toContain(KEPT_MARKER);
  });

  it('keeps the work across a second stop and continue', async () => {
    fixture = createStopContinueFixture(
      implementerCalls([{ writes: BOTH_FILES, holds: true }, { holds: true }, {}]),
    );
    const target = fixture;

    const parked = await startAndSignal(target, 'SIGINT', signalDir(target, 0));
    expect(parked.exitCode).toBe(0);
    const parkedAgain = await continueAndSignal(target, 'SIGINT', signalDir(target, 1));
    expect(parkedAgain.exitCode).toBe(0);
    expect(parkedAgain.sessionId).toBe(parked.sessionId);
    expect(readState(target, parked.sessionId).interruptedStep?.cut).toBe('mid-step');

    const resumed = await continueRun(target);
    expect(resumed.exitCode, resumed.stderr).toBe(0);
    expect(resumed.stdout).toContain('task T001: done (no checks)');
    expect(invocations(target)).toBe(3);
    expect(await retries(target, parked.sessionId)).toEqual([]);

    const patch = await endRunPatch(target, parked.sessionId);
    expect(patch).toContain(KEPT_GREET);
    expect(patch).toContain(KEPT_MARKER);
  });

  it('keeps the first file when the stop came before the second', async () => {
    fixture = createStopContinueFixture(
      implementerCalls([
        { writes: { [MARKER_FILE]: MARKER_SOURCE }, holds: true },
        { writes: { [GREET_FILE]: GREET_SOURCE } },
      ]),
    );
    const target = fixture;

    const parked = await startAndSignal(target, 'SIGINT', signalDir(target, 0));
    expect(parked.exitCode).toBe(0);
    expect(readState(target, parked.sessionId).interruptedStep?.kept).toEqual([MARKER_FILE]);

    const resumed = await continueRun(target);
    expect(resumed.exitCode, resumed.stderr).toBe(0);
    expect(resumed.stdout).toContain('task T001: done (no checks)');
    expect(invocations(target)).toBe(2);
    expect(await retries(target, parked.sessionId)).toEqual([]);
    // The call names the file it wrote, and the file the stopped attempt left beside it, once.
    for (const rows of await resumedRows(target, parked.sessionId)) {
      const done = rows.findIndex((row) => /^src\/greet\.ts(?: {2}|$)/.test(row));
      expect(done).toBeGreaterThan(0);
      expect(rows[done + 1]).toBe(`kept the interrupted attempt's work · ${MARKER_FILE}`);
    }

    const patch = await endRunPatch(target, parked.sessionId);
    expect(patch).toContain(KEPT_GREET);
    expect(patch).toContain(KEPT_MARKER);
  });

  it('still retries a resumed brief that has no change at all', async () => {
    fixture = createStopContinueFixture(implementerCalls([{ holds: true }, {}]));
    const target = fixture;

    const parked = await startAndSignal(target, 'SIGINT', signalDir(target, 0));
    expect(parked.exitCode).toBe(0);
    // The stop cut the brief before it wrote a file: it kept nothing, and says so by saying nothing.
    expect(readState(target, parked.sessionId).interruptedStep).toMatchObject({
      step: { kind: 'brief', taskId: 'T001' },
      cut: 'mid-step',
    });
    expect(readState(target, parked.sessionId).interruptedStep).not.toHaveProperty('kept');
    expect(settledStopLead(target, parked.sessionId)).toBe('Stopped at T001');

    const resumed = await continueRun(target);
    expect(resumed.exitCode, resumed.stderr).toBe(0);
    expect(resumed.stdout).toContain('task T001: done (no checks)');
    expect(invocations(target)).toBe(3);
    expect(await retries(target, parked.sessionId)).toHaveLength(1);
  });
});

/** The correction a stopped run is continued with: it changes a file the brief already wrote. */
const DEFAULT_EXPORT_CORRECTION = 'also export a default from src/greet.ts';

const GREET_WITH_DEFAULT = `${GREET_SOURCE}\n\nexport default greet;\n`;

const DEFAULT_EXPORT_DECISION = {
  what: 'Added a default export to src/greet.ts',
  why: 'The user asked for it after the brief was written.',
};

/** The resumed call carries out the correction and reports it as a decision. */
const CORRECTED_CALL: ImplementerCall = {
  writes: { [GREET_FILE]: GREET_WITH_DEFAULT },
  report: {
    status: 'done',
    filesChanged: [GREET_FILE],
    touchedNotSuggested: [],
    notes: null,
    decisions: [DEFAULT_EXPORT_DECISION],
  },
};

/** A later call writes nothing, as a seat with nothing left to do does. */
const IDLE_CALL: ImplementerCall = { report: IDLE_REPORT };

const KEEP_ANSWER = 'Yes, keep the default export';

const CONFIRM_ANSWER = {
  answer: {
    diagnosis: 'The user asked for the default export.',
    action: 'confirm',
    decisions: [DEFAULT_EXPORT_DECISION],
  },
};

const ASK_ANSWER = {
  answer: {
    diagnosis: 'The default export changes what is built.',
    action: 'ask-user',
    question: 'Did you ask for greet to also be a default export of src/greet.ts?',
    whyOnlyUserCanAnswer: 'Only the user knows whether they asked for it.',
    choices: ['No, remove the default export', KEEP_ANSWER],
    default: 'No, remove the default export',
  },
};

const KEEP_GUIDANCE = {
  answer: {
    diagnosis: 'The user keeps the default export.',
    action: 'guidance',
    instructions: 'Keep the default export as it is.',
    context: null,
  },
};

/**
 * The planner's consults: the final review saves its prompt; a decision confirm saves its prompt,
 * answers `answer` once the prompt carries `answerWhen`, and otherwise asks with a default that
 * removes the default export; a repair consult tells the retry to drop the default export, as
 * the live planner did.
 */
function consultScript(
  tmpDir: string,
  answerWhen: string,
  answer: Readonly<Record<string, unknown>> = CONFIRM_ANSWER,
): string {
  const repair = {
    answer: {
      diagnosis: 'The retry changed nothing.',
      action: 'guidance',
      instructions: 'Write src/greet.ts again. Do not add a default export.',
      context: null,
    },
  };
  return `(prompt) => {
  const fs = process.getBuiltinModule('node:fs');
  if (prompt.includes('Final Implementation Review')) {
    fs.writeFileSync(${JSON.stringify(join(tmpDir, 'review-prompt'))}, prompt);
    return undefined;
  }
  if (prompt.includes('Confirm reported decisions')) {
    const dir = ${JSON.stringify(join(tmpDir, 'confirm-prompts'))};
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(dir + '/' + fs.readdirSync(dir).length, prompt);
    return JSON.stringify(prompt.includes(${JSON.stringify(answerWhen)}) ? ${JSON.stringify(answer)} : ${JSON.stringify(ASK_ANSWER)});
  }
  if (prompt.includes('Consult on a failing task') || prompt.includes('Consult continued')) return ${JSON.stringify(JSON.stringify(repair))};
  return undefined;
}`;
}

function confirmPrompts(target: StopContinueFixture): string[] {
  const dir = join(target.tmpDir, 'confirm-prompts');
  return readdirSync(dir)
    .sort((a, b) => Number(a) - Number(b))
    .map((name) => readFileSync(join(dir, name), 'utf8'));
}

async function eventTypes(target: StopContinueFixture, sessionId: string): Promise<string[]> {
  const { events } = await readRunEvents({ projectDir: target.projectDir, sessionId });
  return events.map((event) => event.type);
}

/** Applies the ready run and returns the greeting file Apply wrote into the checkout. */
async function appliedGreet(target: StopContinueFixture, sessionId: string): Promise<string> {
  const applied = await applyRun(target, sessionId);
  expect(applied.exitCode, applied.stderr).toBe(0);
  expect(readState(target, sessionId).closed?.as).toBe('applied');
  expect(readFileSync(target.markerPath, 'utf8')).toBe(MARKER_SOURCE);
  return readFileSync(target.greetPath, 'utf8');
}

describe('a correction on a stopped run reaches the plan seat', { timeout: 240_000 }, () => {
  it('confirms the decision the correction caused without a question or a retry', async () => {
    fixture = createStopContinueFixture(
      implementerCalls([{ writes: BOTH_FILES, holds: true }, CORRECTED_CALL, IDLE_CALL]),
      { consult: (tmpDir) => consultScript(tmpDir, DEFAULT_EXPORT_CORRECTION) },
    );
    const target = fixture;

    const parked = await startAndSignal(target, 'SIGINT', signalDir(target, 0));
    expect(parked.exitCode).toBe(0);

    const asked: PlannerConversation[] = [];
    const resumed = await continueWithCorrection(
      target,
      parked.sessionId,
      DEFAULT_EXPORT_CORRECTION,
      {
        onPlannerReply: async (conversation) => {
          asked.push(conversation);
          return undefined;
        },
      },
    );

    expect(resumed.tasks).toMatchObject([{ id: 'T001', status: 'done' }]);
    expect(asked).toEqual([]);
    expect(confirmPrompts(target)).toEqual([expect.stringContaining(DEFAULT_EXPORT_CORRECTION)]);
    expect(invocations(target)).toBe(2);
    const types = await eventTypes(target, parked.sessionId);
    expect(types).not.toContain('task_retry');
    expect(types).not.toContain('task_escalating');
    expect(types).not.toContain('implementer_generate_failed');
    expect(readFileSync(join(target.tmpDir, 'review-prompt'), 'utf8')).toContain(
      `T001:\n\`\`\`\n${DEFAULT_EXPORT_CORRECTION}\n\`\`\``,
    );
    expect(resumed.plan?.decisions).toContainEqual({
      text: `${DEFAULT_EXPORT_DECISION.what} — ${DEFAULT_EXPORT_DECISION.why}`,
      taskId: 'T001',
    });

    expect(await appliedGreet(target, parked.sessionId)).toBe(GREET_WITH_DEFAULT);
  });

  it('validates the kept work when the user answers keep, with no new build call', async () => {
    fixture = createStopContinueFixture(
      implementerCalls([{ writes: BOTH_FILES, holds: true }, CORRECTED_CALL, IDLE_CALL]),
      { consult: (tmpDir) => consultScript(tmpDir, KEEP_ANSWER) },
    );
    const target = fixture;

    const parked = await startAndSignal(target, 'SIGINT', signalDir(target, 0));
    expect(parked.exitCode).toBe(0);

    const asked: PlannerConversation[] = [];
    const resumed = await continueWithCorrection(
      target,
      parked.sessionId,
      DEFAULT_EXPORT_CORRECTION,
      {
        onPlannerReply: async (conversation) => {
          asked.push(conversation);
          return plainUserMessage(KEEP_ANSWER);
        },
      },
    );

    expect(resumed.tasks).toMatchObject([{ id: 'T001', status: 'done' }]);
    expect(asked).toHaveLength(1);
    expect(asked[0]?.questions[0]?.text).toContain(
      `Your instructions for T001:\n- ${DEFAULT_EXPORT_CORRECTION}`,
    );
    const prompts = confirmPrompts(target);
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain(DEFAULT_EXPORT_CORRECTION);
    expect(prompts[1]).toContain(DEFAULT_EXPORT_CORRECTION);
    expect(prompts[1]).toContain(KEEP_ANSWER);
    expect(invocations(target)).toBe(2);
    const types = await eventTypes(target, parked.sessionId);
    expect(types).not.toContain('task_retry');
    expect(types).not.toContain('task_escalating');
    expect(types).not.toContain('implementer_generate_failed');

    expect(await appliedGreet(target, parked.sessionId)).toBe(GREET_WITH_DEFAULT);
  });

  it.each([
    ['asks again', ASK_ANSWER, 2],
    ['answers with guidance', KEEP_GUIDANCE, 1],
  ] as const)(
    'passes the kept work when the planner %s after the user answers keep',
    async (_label, afterKeep, questions) => {
      fixture = createStopContinueFixture(
        implementerCalls([{ writes: BOTH_FILES, holds: true }, CORRECTED_CALL, IDLE_CALL]),
        { consult: (tmpDir) => consultScript(tmpDir, KEEP_ANSWER, afterKeep) },
      );
      const target = fixture;

      const parked = await startAndSignal(target, 'SIGINT', signalDir(target, 0));
      expect(parked.exitCode).toBe(0);

      const asked: PlannerConversation[] = [];
      const resumed = await continueWithCorrection(
        target,
        parked.sessionId,
        DEFAULT_EXPORT_CORRECTION,
        {
          onPlannerReply: async (conversation) => {
            asked.push(conversation);
            return plainUserMessage(KEEP_ANSWER);
          },
        },
      );

      expect(resumed.tasks).toMatchObject([{ id: 'T001', status: 'done' }]);
      expect(asked).toHaveLength(questions);
      expect(confirmPrompts(target)).toHaveLength(2);
      // The call that delivers the answer finds the kept work right and writes nothing.
      expect(invocations(target)).toBe(3);
      const types = await eventTypes(target, parked.sessionId);
      expect(types).not.toContain('task_retry');
      expect(types).not.toContain('task_escalating');
      expect(types).not.toContain('implementer_generate_failed');

      expect(await appliedGreet(target, parked.sessionId)).toBe(GREET_WITH_DEFAULT);
    },
  );
});
