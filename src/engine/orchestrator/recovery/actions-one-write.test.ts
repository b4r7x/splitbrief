import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeRecoveryIssue } from '#testing/helpers/factories/recovery.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { makeBusRecorder } from '#testing/helpers/orchestrator-factories.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { SESSION_LOG_FILE, sessionDir } from '../../../core/paths.js';
import { ensureSessionDir } from '../../../core/paths-io.js';
import type { RecoveryAction } from '../../../core/schemas/enums.js';
import type { RecoveryIssue } from '../../../core/schemas/recovery/schemas.js';
import { taskId } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { loadState, saveState } from '../../../core/state/persistence.js';
import type { SessionRef } from '../../../core/types/session-ref.js';
import { plainUserMessage, type UserMessageInput } from '../../../core/types/user-input.js';
import { formatMessageInput } from '../queue/prompt.js';
import { recordBriefCorrection } from '../state-ops.js';
import { applyRecoveryAction } from './actions.js';
import { buildConsultBoundRecoveryIssue } from './builders/consult.js';
import { buildReviewInputTooLargeRecoveryIssue } from './builders/review-input.js';
import { buildReviewFailedRecoveryIssue } from './builders/task.js';

// A process can stop between two state writes (a kill, a lost machine, or a write that throws).
// The armed write of state.json stops the action there; every other write is real.
const stateWrites = vi.hoisted(() => ({
  stopAt: 0,
  seen: 0,
  kind: 'stop' as 'stop' | 'conflict',
  beforeConflict: undefined as (() => void) | undefined,
}));
vi.mock('../../../lib/confined-fs-atomic.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/confined-fs-atomic.js')>();
  return {
    ...actual,
    confinedAtomicWriteFileSync: (
      ...args: Parameters<typeof actual.confinedAtomicWriteFileSync>
    ): ReturnType<typeof actual.confinedAtomicWriteFileSync> => {
      if (stateWrites.stopAt === 0 || !args[0].endsWith('/state.json')) {
        return actual.confinedAtomicWriteFileSync(...args);
      }
      stateWrites.seen += 1;
      if (stateWrites.seen !== stateWrites.stopAt)
        return actual.confinedAtomicWriteFileSync(...args);
      stateWrites.stopAt = 0;
      if (stateWrites.kind === 'stop') throw new Error('the process stopped here');
      stateWrites.beforeConflict?.();
      return { kind: 'conflict', observedRevision: null };
    },
  };
});

const createdAt = '2026-04-28T12:00:00.000Z';
const note = plainUserMessage('split the first brief');

let dirs: string[] = [];

afterEach(() => {
  stateWrites.stopAt = 0;
  stateWrites.kind = 'stop';
  stateWrites.beforeConflict = undefined;
  for (const dir of dirs) cleanupTempDir(dir);
  dirs = [];
});

function setupSession(name: string): SessionRef {
  const projectDir = createTempDir(name);
  dirs.push(projectDir);
  const sessionId = `sess-${name}`;
  ensureSessionDir(projectDir, sessionId);
  return { projectDir, sessionId };
}

function saved(ref: SessionRef): WorkflowState {
  const state = loadState(ref);
  if (state === null) throw new Error('expected a saved state');
  return state;
}

function persist(ref: SessionRef, state: WorkflowState): WorkflowState {
  saveState(ref, state);
  return saved(ref);
}

function userRows(ref: SessionRef): string[] {
  const log = join(sessionDir(ref.projectDir, ref.sessionId), SESSION_LOG_FILE);
  if (!existsSync(log)) return [];
  return readFileSync(log, 'utf-8')
    .split('\n')
    .filter((line) => line.includes('"kind":"message"') && line.includes('"role":"user"'));
}

/** Runs the action with the given state write armed; a stop leaves what the earlier writes saved. */
async function runStoppedAt(
  stopAt: number,
  kind: 'stop' | 'conflict',
  run: () => Promise<unknown>,
): Promise<void> {
  stateWrites.seen = 0;
  stateWrites.stopAt = stopAt;
  stateWrites.kind = kind;
  await run().then(
    () => undefined,
    (err: unknown) => {
      if (!(err instanceof Error)) throw err;
    },
  );
  stateWrites.stopAt = 0;
}

/** A reopened run replays an action it saved as applying, the way the recovery driver does. */
async function reopen(
  ref: SessionRef,
  takesNote: boolean,
  words: UserMessageInput | undefined,
): Promise<void> {
  const state = saved(ref);
  const issue = state.pendingRecovery;
  if (issue?.status !== 'applying' || issue.selectedAction === undefined) return;
  await applyRecoveryAction({
    ...ref,
    state,
    action: issue.selectedAction,
    bus: makeBusRecorder().bus,
    ...(takesNote && words !== undefined && { comment: words }),
  });
}

type NoteCase = Readonly<{
  name: string;
  /** The state writes the action made before it became one write. */
  oldWrites: number;
  action: RecoveryAction;
  comment: UserMessageInput | undefined;
  takesNote: boolean;
  setup: (ref: SessionRef) => WorkflowState;
  /** What the action saves: `none` before it applied, `once` after. */
  effect: (state: WorkflowState) => unknown;
  none: unknown;
  once: unknown;
}>;

function plannerHalt(issue: RecoveryIssue, phase: WorkflowState['phase'] = 'planning') {
  return (ref: SessionRef) =>
    persist(ref, { ...makeImplState([makeTask({ id: 'T001' })]), phase, pendingRecovery: issue });
}

const queuedTexts = (state: WorkflowState): string[] =>
  state.messageQueue.map((message) => message.text);

const tooLarge = (phase: WorkflowState['phase']): RecoveryIssue =>
  buildReviewInputTooLargeRecoveryIssue({
    phase,
    failure: {
      kind: 'input-too-large',
      figures: { unit: 'characters', size: 900_000, limit: 400_000 },
      promptSize: { characters: 900_000 },
      largestFiles: [],
    },
    tool: 'codex',
    acceptAsIs: true,
    createdAt,
  });

const NOTE_CASES: readonly NoteCase[] = [
  {
    name: 'revise with a note',
    oldWrites: 3,
    action: 'revise',
    comment: note,
    takesNote: true,
    setup: plannerHalt(
      makeRecoveryIssue({
        reason: 'plan-checks-failed',
        phase: 'planning',
        taskId: undefined,
        affectedTaskIds: [],
        availableActions: ['revise', 'end-run'],
        recommendedAction: 'revise',
      }),
    ),
    effect: queuedTexts,
    none: [],
    once: [note.text],
  },
  {
    name: 'a failed review sent back with words',
    oldWrites: 3,
    action: 'revise',
    comment: note,
    takesNote: true,
    setup: (ref) =>
      persist(ref, {
        ...makeImplState([makeTask({ id: 'T001', status: 'done' })]),
        phase: 'complete',
        reviewStatus: 'failed',
        pendingRecovery: buildReviewFailedRecoveryIssue({
          blocking: 1,
          phase: 'complete',
          createdAt,
        }),
      }),
    effect: (state) =>
      state.pendingTriage?.inputs.map((input) => `${input.id} ${input.text}`) ?? [],
    none: [],
    once: [`U1 ${note.text}`],
  },
  {
    name: 'Accept as is on a final review too large',
    oldWrites: 4,
    action: 'accept-as-is',
    comment: note,
    takesNote: true,
    setup: (ref) =>
      persist(ref, {
        ...makeImplState([makeTask({ id: 'T001', status: 'done' })]),
        phase: 'final-review',
        pendingRecovery: tooLarge('final-review'),
      }),
    effect: (state) => ({ note: state.acceptedAsIs?.note, review: state.reviewStatus }),
    none: { note: undefined, review: undefined },
    once: { note: note.text, review: 'failed' },
  },
  {
    name: 'Accept as is on a scheduled task review too large',
    oldWrites: 4,
    action: 'accept-as-is',
    comment: note,
    takesNote: true,
    setup: (ref) =>
      persist(ref, {
        ...makeImplState([makeTask({ id: 'T001', status: 'done' }), makeTask({ id: 'T002' })], {
          currentTaskIndex: 1,
        }),
        pendingScheduledReview: { afterTaskId: taskId('T001') },
        pendingRecovery: tooLarge('implementing'),
      }),
    effect: (state) => ({
      note: state.acceptedAsIs?.note,
      scheduled: state.pendingScheduledReview?.afterTaskId,
    }),
    none: { note: undefined, scheduled: 'T001' },
    once: { note: note.text, scheduled: undefined },
  },
  {
    name: 'Accept as is on a failed final review',
    oldWrites: 3,
    action: 'accept-as-is',
    comment: undefined,
    takesNote: false,
    setup: (ref) =>
      persist(ref, {
        ...makeImplState([makeTask({ id: 'T001', status: 'done' })]),
        phase: 'complete',
        reviewStatus: 'failed',
        pendingRecovery: buildReviewFailedRecoveryIssue({
          blocking: 1,
          phase: 'complete',
          acceptAsIs: true,
          createdAt,
        }),
      }),
    effect: (state) => state.acceptedAsIs !== undefined,
    none: false,
    once: true,
  },
  {
    name: 'Continue on a spent planner-call allowance with no brief',
    oldWrites: 3,
    action: 'continue',
    comment: note,
    takesNote: true,
    setup: (ref) =>
      persist(ref, {
        ...makeImplState([makeTask({ id: 'T001', status: 'in_progress' })]),
        plannerCalls: { used: 10, allowance: 10 },
        pendingRecovery: buildConsultBoundRecoveryIssue({
          reason: 'planner-calls-spent',
          lastDiagnosis: 'The review needs triage',
          plannerCalls: 10,
          plannerCallAllowance: 10,
          phase: 'implementing',
          createdAt,
        }),
      }),
    effect: (state) => state.plannerCalls?.allowance,
    none: 10,
    once: 15,
  },
  {
    name: 'Continue on a spent consult bound that names no brief',
    oldWrites: 4,
    action: 'continue',
    comment: note,
    takesNote: true,
    setup: (ref) =>
      persist(ref, {
        ...makeImplState([makeTask({ id: 'T001', status: 'in_progress' })]),
        attempt: 2,
        pendingRecovery: buildConsultBoundRecoveryIssue({
          reason: 'consult-bound-spent',
          lastDiagnosis: 'The brief keeps failing its test',
          phase: 'implementing',
          createdAt,
        }),
      }),
    effect: (state) => ({
      notes: state.lineages?.T001?.notes ?? [],
      corrections: state.lineages?.T001?.corrections ?? [],
      attempt: state.attempt,
    }),
    none: { notes: [], corrections: [], attempt: 2 },
    once: { notes: [note.text], corrections: [note.text], attempt: 0 },
  },
  {
    name: 'Try again on a seat-level halt with a note',
    oldWrites: 3,
    action: 'retry-same-worker',
    comment: note,
    takesNote: true,
    setup: plannerHalt(
      makeRecoveryIssue({
        id: 'seat-failed',
        reason: 'planner-call-failed',
        phase: 'planning',
        seat: 'plan',
        taskId: undefined,
        affectedTaskIds: [],
        availableActions: ['retry-same-worker', 'end-run'],
      }),
    ),
    effect: queuedTexts,
    none: [],
    once: [note.text],
  },
  {
    name: 'Try again on a brief with words',
    oldWrites: 3,
    action: 'retry-same-worker',
    comment: note,
    takesNote: true,
    setup: (ref) =>
      persist(ref, {
        ...makeImplState([makeTask({ id: 'T001', status: 'in_progress' })]),
        attempt: 2,
        pendingRecovery: makeRecoveryIssue(),
      }),
    effect: (state) => ({
      corrections: state.lineages?.T001?.corrections ?? [],
      attempt: state.attempt,
    }),
    none: { corrections: [], attempt: 2 },
    once: { corrections: [note.text], attempt: 0 },
  },
];

function runCase(ref: SessionRef, testCase: NoteCase, state: WorkflowState) {
  return applyRecoveryAction({
    ...ref,
    state,
    action: testCase.action,
    bus: makeBusRecorder().bus,
    ...(testCase.comment !== undefined && { comment: testCase.comment }),
  });
}

function expectNothingOrAll(testCase: NoteCase, state: WorkflowState): void {
  expect(state.pendingRecovery?.status).not.toBe('applying');
  expect(testCase.effect(state)).toEqual(
    state.pendingRecovery === undefined ? testCase.once : testCase.none,
  );
}

const stops = (testCase: NoteCase) =>
  Array.from({ length: testCase.oldWrites + 1 }, (_, index) => ({ testCase, stopAt: index + 1 }));

describe('a note action saves its halt answer in one write', () => {
  describe.each(NOTE_CASES)('$name', (testCase) => {
    it.each(
      stops(testCase).flatMap((stop) => [
        { ...stop, kind: 'stop' as const },
        { ...stop, kind: 'conflict' as const },
      ]),
    )(
      'leaves nothing or all of it saved after a $kind at state write $stopAt',
      async ({ stopAt, kind }) => {
        const ref = setupSession(`one-write-${kind}-${stopAt}`);
        const state = testCase.setup(ref);

        await runStoppedAt(stopAt, kind, () => runCase(ref, testCase, state));

        expectNothingOrAll(testCase, saved(ref));
      },
    );

    it.each(
      stops(testCase).flatMap((stop) => [
        { ...stop, typed: 'nothing', words: undefined },
        { ...stop, typed: 'the note again', words: note },
      ]),
    )(
      'applies it once when the run reopens after a stop at state write $stopAt with $typed typed',
      async ({ stopAt, words }) => {
        const ref = setupSession(`one-write-reopen-${stopAt}`);
        const state = testCase.setup(ref);
        await runStoppedAt(stopAt, 'stop', () => runCase(ref, testCase, state));

        await reopen(ref, testCase.takesNote, words);

        expectNothingOrAll(testCase, saved(ref));
      },
    );
  });
});

describe('the user row of a note action follows its saved state', () => {
  const reviewCorrection = NOTE_CASES[1];
  if (reviewCorrection === undefined) throw new Error('expected the review-correction case');

  it.each([1, 2, 3, 4])(
    'shows no row for a correction a stop at state write %i left unsaved',
    async (stopAt) => {
      const ref = setupSession(`row-after-state-${stopAt}`);
      const state = reviewCorrection.setup(ref);

      await runStoppedAt(stopAt, 'stop', () => runCase(ref, reviewCorrection, state));

      const correctionSaved = saved(ref).pendingTriage?.inputs.length === 1;
      expect(userRows(ref).some((row) => row.includes(note.text))).toBe(correctionSaved);
    },
  );

  // The one window left: the state is saved and the log append fails. The append reports the
  // failure on stderr and does not throw, so the note is delivered with no transcript row.
  it.each([NOTE_CASES[0], NOTE_CASES[1], NOTE_CASES[7]])(
    'keeps $name delivered once when its row cannot be written',
    async (testCase) => {
      if (testCase === undefined) throw new Error('expected a note case');
      const ref = setupSession(`row-fails-${testCase.action}`);
      const state = testCase.setup(ref);
      mkdirSync(join(sessionDir(ref.projectDir, ref.sessionId), SESSION_LOG_FILE));
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

      const result = await runCase(ref, testCase, state);
      const warned = stderr.mock.calls.flat().join('');
      stderr.mockRestore();

      expect(result.ok).toBe(true);
      expectNothingOrAll(testCase, saved(ref));
      expect(saved(ref).pendingRecovery).toBeUndefined();
      expect(warned).toContain('Could not save the run log');
    },
  );
});

describe('Continue on a spent consult bound refused for a brief that is not current', () => {
  it('refuses before any write, so no grant is saved', async () => {
    const ref = setupSession('grant-refused');
    const issue = buildConsultBoundRecoveryIssue({
      reason: 'consult-bound-spent',
      lastDiagnosis: 'The brief keeps failing its test',
      phase: 'implementing',
      task: makeTask({ id: 'T001' }),
      createdAt,
    });
    const state = persist(ref, {
      ...makeImplState([makeTask({ id: 'T001', status: 'done' }), makeTask({ id: 'T002' })], {
        currentTaskIndex: 1,
      }),
      pendingRecovery: issue,
    });

    const result = await applyRecoveryAction({
      ...ref,
      state,
      action: 'continue',
      bus: makeBusRecorder().bus,
      comment: note,
    });

    expect(result).toMatchObject({ ok: false, code: 'missing-current-task' });
    expect(saved(ref).pendingRecovery).toEqual(issue);
    expect(saved(ref).lineages).toBeUndefined();
    expect(saved(ref).stateRevision).toBe(state.stateRevision);
  });
});

describe('Try again on a brief with words', () => {
  const image = {
    id: 'img-1',
    kind: 'image' as const,
    path: '/tmp/shot.png',
    mimeType: 'image/png',
    sizeBytes: 10,
  };
  const words: UserMessageInput = { ...note, images: [image] };

  it('keeps the words and images on the brief, and the retried brief does not add them again', async () => {
    const ref = setupSession('brief-retry-words');
    const state = NOTE_CASES[8]?.setup(ref);
    if (state === undefined) throw new Error('expected the brief retry case');

    const result = await applyRecoveryAction({
      ...ref,
      state,
      action: 'retry-same-worker',
      bus: makeBusRecorder().bus,
      comment: words,
    });
    if (!result.ok) throw new Error('expected the retry to apply');
    const afterAction = saved(ref);
    const retried = recordBriefCorrection(
      ref,
      result.state,
      taskId('T001'),
      formatMessageInput(words),
      words.images,
    );

    expect(afterAction.lineages?.T001?.corrections).toEqual([formatMessageInput(words)]);
    expect(afterAction.lineages?.T001?.correctionImages).toEqual([image]);
    expect(retried.lineages?.T001).toEqual(afterAction.lineages?.T001);
  });
});

describe('a state conflict on the one write', () => {
  it('fails a revise with the conflict and leaves the halt open', async () => {
    const ref = setupSession('conflict-revise');
    const testCase = NOTE_CASES[0];
    if (testCase === undefined) throw new Error('expected the revise case');
    const state = testCase.setup(ref);
    stateWrites.seen = 0;
    stateWrites.stopAt = 1;
    stateWrites.kind = 'conflict';

    await expect(runCase(ref, testCase, state)).rejects.toMatchObject({ kind: 'state-conflict' });

    expect(saved(ref).pendingRecovery).toEqual(state.pendingRecovery);
    expect(saved(ref).messageQueue).toEqual([]);
  });

  it('retries a seat-level Try again while the same halt is open', async () => {
    const ref = setupSession('conflict-seat-retry');
    const testCase = NOTE_CASES[7];
    if (testCase === undefined) throw new Error('expected the seat-level case');
    const state = testCase.setup(ref);
    stateWrites.seen = 0;
    stateWrites.stopAt = 1;
    stateWrites.kind = 'conflict';

    const result = await runCase(ref, testCase, state);

    expect(result).toMatchObject({ ok: true, correctionRecorded: true });
    expect(saved(ref).pendingRecovery).toBeUndefined();
    expect(queuedTexts(saved(ref))).toEqual([note.text]);
  });

  it('fails a seat-level Try again when another writer answered the halt first', async () => {
    const ref = setupSession('conflict-seat-retry-answered');
    const testCase = NOTE_CASES[7];
    if (testCase === undefined) throw new Error('expected the seat-level case');
    const state = testCase.setup(ref);
    const answered = { ...state, pendingRecovery: undefined };
    stateWrites.seen = 0;
    stateWrites.stopAt = 1;
    stateWrites.kind = 'conflict';
    stateWrites.beforeConflict = () => saveState(ref, answered);

    await expect(runCase(ref, testCase, state)).rejects.toMatchObject({ kind: 'state-conflict' });

    expect(saved(ref).pendingRecovery).toBeUndefined();
    expect(saved(ref).messageQueue).toEqual([]);
  });

  it('fails a seat-level Try again on an older state when another process answered the halt first', async () => {
    const ref = setupSession('stale-seat-retry-answered');
    const testCase = NOTE_CASES[7];
    if (testCase === undefined) throw new Error('expected the seat-level case');
    const state = testCase.setup(ref);
    const first = await runCase(ref, testCase, state);
    if (!first.ok) throw new Error('expected the first answer to apply');

    await expect(runCase(ref, testCase, state)).rejects.toMatchObject({ kind: 'state-conflict' });

    expect(saved(ref).pendingRecovery).toBeUndefined();
    expect(queuedTexts(saved(ref))).toEqual([note.text]);
  });

  it('applies a seat-level Try again on an older state while the same halt is still open', async () => {
    const ref = setupSession('stale-seat-retry-open');
    const testCase = NOTE_CASES[7];
    if (testCase === undefined) throw new Error('expected the seat-level case');
    const state = testCase.setup(ref);
    persist(ref, { ...state, stateRevision: (state.stateRevision ?? 0) + 1 });

    const result = await runCase(ref, testCase, state);

    expect(result).toMatchObject({ ok: true, correctionRecorded: true });
    expect(saved(ref).pendingRecovery).toBeUndefined();
    expect(queuedTexts(saved(ref))).toEqual([note.text]);
  });
});
