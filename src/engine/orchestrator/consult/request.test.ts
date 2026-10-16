import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeTaskSpec } from '#testing/helpers/factories/plan.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeRunnerCallResult } from '#testing/helpers/factories/runner-call.js';
import { makeBusRecorder } from '#testing/helpers/orchestrator-factories.js';
import { setupProject } from '#testing/helpers/planning-phase.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { taskId } from '../../../core/schemas/task.js';
import type { ChangedFilesSnapshot, WorkflowState } from '../../../core/schemas/workflow.js';
import { createInitialState, transition } from '../../../core/state/machine.js';
import { loadState, saveState } from '../../../core/state/persistence.js';
import { readMessages } from '../../../core/sessions/log-reader.js';
import { appendMessage } from '../../../core/sessions/log-writer.js';
import type { Planner, TypedCallContext } from '../../planners/types.js';
import type { TypedSeatCall } from '../../runners/typed-output.js';
import type { Task } from '../../../core/schemas/task.js';
import { retryFailureLabel } from '../task/retry.js';
import { consultSeat, requestConsult, thrownConsultSeat, type ConsultContext } from './request.js';
import { captureWorkspaceSnapshot } from '../isolation/entry-snapshot.js';
import { getChangedFilesSinceSnapshot } from '../approval/file-snapshots/capture.js';

const config = makeConfig();
const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) cleanupTempDir(dir);
});

type ScriptedConsult = Readonly<{
  text: string;
  nativeSessionId?: string | null;
  throws?: string;
}>;

function consultPlanner(
  script: ScriptedConsult[],
  supportsSessionResume: boolean,
): {
  planner: Pick<Planner, 'capabilities' | 'typedCall'>;
  prompts: string[];
  contexts: TypedCallContext[];
} {
  const prompts: string[] = [];
  const contexts: TypedCallContext[] = [];
  const typedCall = (ctx: TypedCallContext): TypedSeatCall => {
    contexts.push(ctx);
    return {
      seat: ctx.seat,
      typedOutput: 'fallback',
      canResume: supportsSessionResume,
      invoke: async ({ prompt }) => {
        prompts.push(prompt);
        const next = script.shift();
        if (next === undefined) throw new Error('the planner was asked once too often');
        if (next.throws !== undefined) throw new Error(next.throws);
        return makeRunnerCallResult({
          status: 'completed',
          text: next.text,
          ...(next.nativeSessionId !== undefined && { nativeSessionId: next.nativeSessionId }),
          usage: { inputTokens: 10, outputTokens: 5 },
        });
      },
    };
  };
  return {
    planner: {
      capabilities: {
        supportsConversationalPlanning: false,
        supportsSessionResume,
        supportsEffort: false,
        supportsImages: false,
        supportsSelfSummarisation: false,
      },
      typedCall,
    },
    prompts,
    contexts,
  };
}

function guidanceAnswer(diagnosis: string, nativeSessionId: string | null): ScriptedConsult {
  return {
    text: JSON.stringify({
      answer: {
        diagnosis,
        action: 'guidance',
        instructions: 'Use the named export.',
        context: null,
      },
    }),
    nativeSessionId,
  };
}

function rewriteAnswer(id: string, nativeSessionId: string | null): ScriptedConsult {
  return {
    text: JSON.stringify({
      answer: {
        diagnosis: 'The brief was wrong',
        action: 'rewrite-task',
        task: makeTaskSpec({ id, suggestedFiles: ['src/greet.ts'] }),
      },
    }),
    nativeSessionId,
  };
}

function splitAnswer(nativeSessionId: string | null): ScriptedConsult {
  return {
    text: JSON.stringify({
      answer: {
        diagnosis: 'The brief was too big',
        action: 'split-task',
        tasks: [
          makeTaskSpec({ id: 'T003', suggestedFiles: ['src/a.ts'] }),
          makeTaskSpec({ id: 'T004', suggestedFiles: ['src/b.ts'] }),
        ],
      },
    }),
    nativeSessionId,
  };
}

function consultState(): WorkflowState {
  return {
    ...transition(createInitialState('greet people'), { type: 'START' }),
    phase: 'validating-task',
    tasks: [makeTask({ id: 'T003', status: 'failed', revision: 1, criteria: ['C1'] })],
    currentTaskIndex: 0,
    attempt: 1,
    plan: {
      summary: 'Greet people by name',
      decisions: [],
      criteria: [{ id: 'C1', text: 'A greeting is returned', checkIds: ['K1'] }],
      checks: [{ id: 'K1', kind: 'test', value: 'src/greet.test.ts', required: true }],
      validation: null,
    },
  };
}

const FIX: NonNullable<Task['fix']> = {
  cycle: 1,
  findings: [
    {
      id: 'F1',
      text: 'The greeting test is red',
      acceptance: null,
      checkIds: ['V1'],
      failureKeys: { V1: ['greet > hello'] },
      redKeys: { V1: ['greet > name'] },
    },
  ],
};

function fixState(): WorkflowState {
  const state = consultState();
  return {
    ...state,
    tasks: [makeTask({ id: 'T003', status: 'failed', revision: 1, criteria: ['C1'], fix: FIX })],
  };
}

function emptySnapshot(): ChangedFilesSnapshot {
  return { head: 'unused', files: [], dirtyFileContents: {} };
}

describe('requestConsult', () => {
  it('shows modifications, deletions and modes from a no-git workspace entry snapshot', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const workspaceDir = createTempDir('consult-entry-workspace');
    dirs.push(workspaceDir);
    const ref = { projectDir, sessionId };
    writeFileSync(join(workspaceDir, 'edit.txt'), 'before\n');
    writeFileSync(join(workspaceDir, 'gone.txt'), 'deleted\n');
    writeFileSync(join(workspaceDir, 'run.sh'), '#!/bin/sh\n');
    chmodSync(join(workspaceDir, 'run.sh'), 0o644);
    const snapshot = await captureWorkspaceSnapshot(workspaceDir, ref);
    writeFileSync(join(workspaceDir, 'edit.txt'), 'after\n');
    rmSync(join(workspaceDir, 'gone.txt'));
    chmodSync(join(workspaceDir, 'run.sh'), 0o755);
    const { bus } = makeBusRecorder();
    const planner = consultPlanner([guidanceAnswer('Answer', null)], true);
    const state = consultState();
    saveState(ref, state);
    const task = state.tasks[0];
    if (task === undefined) throw new Error('missing consult task');

    await requestConsult(
      {
        ...ref,
        workspaceDir,
        bus,
        config,
        planner: planner.planner,
        reviewer: planner.planner,
        state,
      },
      {
        task,
        reason: 'failed',
        failingOutput: 'boom',
        snapshot,
        changedFiles: await getChangedFilesSinceSnapshot(workspaceDir, snapshot),
      },
    );

    expect(planner.prompts[0]).toContain('-before');
    expect(planner.prompts[0]).toContain('+after');
    expect(planner.prompts[0]).toContain('-deleted');
    expect(planner.prompts[0]).toContain('old mode 100644');
    expect(planner.prompts[0]).toContain('new mode 100755');
  });
  it.each([
    {
      handle: 'valid',
      script: [guidanceAnswer('Answer', 'native-2')],
      heading: '# Consult continued',
      redelivered: 0,
    },
    {
      handle: 'expired',
      script: [
        { text: '', throws: 'No conversation found with session id native-q' },
        guidanceAnswer('Answer', 'native-2'),
      ],
      heading: '# Consult on a failing task',
      redelivered: 1,
    },
  ])(
    'continue after an answered question, consult sees workspace code ($handle handle)',
    async ({ script, heading, redelivered }) => {
      const { projectDir, sessionId } = setupProject(dirs);
      const ref = { projectDir, sessionId };
      const workspaceDir = createTempDir('consult-workspace');
      dirs.push(workspaceDir);
      const file = 'src/greet.ts';
      for (const dir of [projectDir, workspaceDir]) mkdirSync(join(dir, 'src'));
      writeFileSync(join(projectDir, file), 'export const greeting = "checkout";\n');
      writeFileSync(join(workspaceDir, file), 'export const greeting = "workspace";\n');
      const reply = 'Greet by first name only.';
      const task = makeTask({
        id: 'T003',
        suggestedFiles: [file],
        status: 'failed',
        revision: 1,
        criteria: ['C1'],
      });
      const planned = { ...consultState(), tasks: [task] };
      let stopped = transition(
        { ...planned, tokenUsage: { ...planned.tokenUsage, plannerInput: 40, plannerOutput: 12 } },
        { type: 'SET_PLANNER_SESSION_ID', sessionId: 'native-q' },
      );
      stopped = transition(stopped, {
        type: 'RECORD_CONSULT',
        taskId: task.id,
        revision: 1,
        reason: 'failed',
        seat: 'plan',
        answer: JSON.parse(guidanceAnswer('Before the stop', null).text),
      });
      stopped = transition(stopped, { type: 'COUNT_PLANNER_CALL' });
      stopped = transition(stopped, { type: 'COUNT_PLANNER_CALL' });
      saveState(ref, stopped);
      appendMessage(ref, { role: 'user', phase: 'planning', text: reply });

      const continued = loadState(ref);
      if (continued === null) throw new Error('the stopped run left no state');
      expect(continued.plannerSessionId).toBe('native-q');
      expect(continued.plannerCalls).toEqual(stopped.plannerCalls);
      expect(continued.tokenUsage).toEqual(stopped.tokenUsage);
      expect(continued.lineages?.T003?.consults).toBe(1);
      expect(continued.lineages).toEqual(stopped.lineages);

      const { bus, events } = makeBusRecorder();
      const planner = consultPlanner([...script], true);
      let state = continued;
      const result = await requestConsult(
        {
          projectDir,
          workspaceDir,
          sessionId,
          bus,
          config,
          planner: planner.planner,
          reviewer: planner.planner,
          state,
          onStateChange: (next) => {
            state = next;
          },
        },
        {
          task,
          reason: 'failed',
          failingOutput: 'missing greeting',
          snapshot: {
            head: 'unused',
            files: [file],
            dirtyFileContents: { [file]: 'export const greeting = "before";\n' },
          },
          changedFiles: [file],
        },
      );

      expect('answer' in result).toBe(true);
      const prompt = planner.prompts.at(-1);
      expect(prompt).toContain(heading);
      expect(prompt).toContain('+export const greeting = "workspace";');
      expect(prompt).not.toContain('greeting = "checkout"');
      expect(prompt).toContain(`The run workspace is \`${workspaceDir}\`.`);
      expect(prompt).toContain('Read project files from this directory');
      expect(planner.contexts.every((context) => context.projectDir === projectDir)).toBe(true);
      const delivered = planner.contexts
        .flatMap((context) => context.priorMessages ?? [])
        .filter((message) => message.content === reply);
      expect(delivered).toHaveLength(redelivered);
      expect(planner.prompts.some((sent) => sent.includes(reply))).toBe(false);
      const logged: string[] = [];
      for await (const message of readMessages(ref)) logged.push(message.text);
      expect(logged.filter((text) => text === reply)).toHaveLength(1);
      expect(loadState(ref)?.plannerSessionId).toBe('native-2');
      expect(state.lineages?.T003?.consults).toBe(2);
      expect(state.lineages?.T003?.consultRecords).toHaveLength(2);
      expect(events.filter((event) => event.type === 'consult_answered')).toHaveLength(1);
      expect(state.plannerCalls?.used).toBe(3);
      expect(state.tokenUsage.plannerInput).toBe(50);
      expect(state.tokenUsage.plannerOutput).toBe(17);
      expect(existsSync(join(workspaceDir, '.splitbrief'))).toBe(false);
    },
  );

  it('reuses the saved planner session id for the second consult on a resumable tool', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const { bus, events } = makeBusRecorder();
    const planner = consultPlanner(
      [guidanceAnswer('First answer', 'native-1'), guidanceAnswer('Second answer', 'native-2')],
      true,
    );
    const state = consultState();
    saveState({ projectDir, sessionId }, state);
    const seen: WorkflowState[] = [];
    const ctx: ConsultContext = {
      projectDir,
      workspaceDir: projectDir,
      sessionId,
      bus,
      config,
      planner: planner.planner,
      reviewer: planner.planner,
      state,
      onStateChange: (next) => seen.push(next),
    };
    const task = state.tasks[0]!;

    const first = await requestConsult(ctx, {
      task,
      reason: 'failed',
      failingOutput: 'first failure',
      snapshot: emptySnapshot(),
      changedFiles: [],
    });
    expect('answer' in first).toBe(true);
    expect(planner.prompts[0]).toContain('# Consult on a failing task');
    expect(planner.prompts[0]).toContain('first failure');
    const afterFirst = seen.at(-1)!;
    expect(afterFirst.plannerSessionId).toBe('native-1');

    const second = await requestConsult(
      { ...ctx, state: afterFirst },
      {
        task,
        reason: 'failed',
        failingOutput: 'second failure',
        snapshot: emptySnapshot(),
        changedFiles: [],
      },
    );
    expect('answer' in second).toBe(true);
    expect(planner.prompts[1]).toContain('# Consult continued');
    expect(planner.prompts[1]).not.toContain('# Consult on a failing task');
    expect(planner.prompts[1]).toContain('second failure');
    expect(planner.prompts[1]!.length).toBeLessThan(planner.prompts[0]!.length);
    expect(planner.contexts.map((context) => context.seat)).toEqual(['planner', 'planner']);

    const afterSecond = seen.at(-1)!;
    expect(afterSecond.plannerSessionId).toBe('native-2');
    expect(afterSecond.lineages?.T003?.consults).toBe(2);
    expect(afterSecond.lineages?.T003?.consultRecords).toHaveLength(2);
    expect(afterSecond.plannerCalls?.used).toBe(2);
    expect(afterSecond.tokenUsage.plannerInput).toBe(20);
    expect(events.filter((event) => event.type === 'consult_answered')).toHaveLength(2);
  });

  it('sends the full prompt every time when the tool cannot resume a session', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const { bus } = makeBusRecorder();
    const planner = consultPlanner(
      [guidanceAnswer('First answer', 'native-1'), guidanceAnswer('Second answer', null)],
      false,
    );
    const state = consultState();
    saveState({ projectDir, sessionId }, state);
    const seen: WorkflowState[] = [];
    const ctx: ConsultContext = {
      projectDir,
      workspaceDir: projectDir,
      sessionId,
      bus,
      config,
      planner: planner.planner,
      reviewer: planner.planner,
      state,
      onStateChange: (next) => seen.push(next),
    };
    const task = state.tasks[0]!;
    const request = {
      task,
      reason: 'failed' as const,
      failingOutput: 'the failure',
      snapshot: emptySnapshot(),
      changedFiles: [],
    };

    await requestConsult(ctx, request);
    await requestConsult({ ...ctx, state: seen.at(-1)! }, request);

    expect(planner.prompts[0]).toContain('# Consult on a failing task');
    expect(planner.prompts[1]).toContain('# Consult on a failing task');
    expect(planner.prompts[1]).toContain('## Plan');
    expect(seen.at(-1)?.plannerSessionId).toBe('native-1');
  });

  it('records a stale consult without marking it applied or spending a planner call', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const { bus } = makeBusRecorder();
    const planner = consultPlanner([guidanceAnswer('Inputs moved.', null)], true);
    const state = consultState();
    saveState({ projectDir, sessionId }, state);
    const seen: WorkflowState[] = [];

    const result = await requestConsult(
      {
        projectDir,
        workspaceDir: projectDir,
        sessionId,
        bus,
        config,
        planner: planner.planner,
        reviewer: planner.planner,
        state,
        onStateChange: (next) => seen.push(next),
      },
      {
        task: state.tasks[0]!,
        reason: 'stale',
        failingOutput: 'stale failure',
        snapshot: emptySnapshot(),
        changedFiles: [],
      },
    );

    expect('answer' in result).toBe(true);
    const after = seen.at(-1)!;
    expect(after.lineages?.T003?.consults).toBe(1);
    expect(after.lineages?.T003?.staleConsultedRevision).toEqual({});
    expect(after.tasks[0]?.inputHashes).toEqual(state.tasks[0]?.inputHashes);
    expect(after.plannerCalls?.used ?? 0).toBe(0);
    expect(after.tokenUsage.plannerInput).toBe(10);
  });

  it('renders the attempt diff from its snapshot and the files it changed', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(join(projectDir, 'src/greet.ts'), 'export const greet = "new";\n');
    const { bus } = makeBusRecorder();
    const planner = consultPlanner([guidanceAnswer('Answer', null)], true);
    const state = consultState();
    saveState({ projectDir, sessionId }, state);

    await requestConsult(
      {
        projectDir,
        workspaceDir: projectDir,
        sessionId,
        bus,
        config,
        planner: planner.planner,
        reviewer: planner.planner,
        state,
      },
      {
        task: state.tasks[0]!,
        reason: 'failed',
        failingOutput: 'boom',
        snapshot: {
          head: 'unused',
          files: ['src/greet.ts'],
          dirtyFileContents: {},
          dirtyFileEntries: {
            'src/greet.ts': {
              base64: Buffer.from('export const greet = "old";\n').toString('base64'),
              mode: 0o644,
            },
          },
        },
        changedFiles: ['src/greet.ts'],
      },
    );

    expect(planner.prompts[0]).toContain('-export const greet = "old";');
    expect(planner.prompts[0]).toContain('+export const greet = "new";');
  });

  it.each(['failed', 'stale'] as const)(
    'repairs a rewritten task id change once for %s and takes the fixed answer',
    async (reason) => {
      const { projectDir, sessionId } = setupProject(dirs);
      const { bus } = makeBusRecorder();
      const planner = consultPlanner(
        [rewriteAnswer('T009', null), guidanceAnswer('Answer', null)],
        true,
      );
      const state = consultState();
      saveState({ projectDir, sessionId }, state);
      const seen: WorkflowState[] = [];

      const result = await requestConsult(
        {
          projectDir,
          workspaceDir: projectDir,
          sessionId,
          bus,
          config,
          planner: planner.planner,
          reviewer: planner.planner,
          state,
          onStateChange: (next) => seen.push(next),
        },
        {
          task: state.tasks[0]!,
          reason,
          failingOutput: 'the failure',
          snapshot: emptySnapshot(),
          changedFiles: [],
        },
      );

      expect('answer' in result && result.answer.answer.action).toBe('guidance');
      expect(planner.prompts).toHaveLength(2);
      expect(planner.prompts[1]).toContain('a rewrite-task must keep the task id T003');
      expect(planner.prompts[1]).toContain('the answer changes it to T009');
      expect(planner.prompts[1]).toContain('failed validation');
      expect(seen.at(-1)?.lineages?.T003?.consults).toBe(1);
    },
  );

  it.each(['failed', 'stale'] as const)(
    'fails the seat protocol when the rewritten task changes its id again for %s',
    async (reason) => {
      const { projectDir, sessionId } = setupProject(dirs);
      const { bus } = makeBusRecorder();
      const planner = consultPlanner(
        [rewriteAnswer('T009', null), rewriteAnswer('T009', null)],
        true,
      );
      const state = consultState();
      saveState({ projectDir, sessionId }, state);

      const result = await requestConsult(
        {
          projectDir,
          workspaceDir: projectDir,
          sessionId,
          bus,
          config,
          planner: planner.planner,
          reviewer: planner.planner,
          state,
        },
        {
          task: state.tasks[0]!,
          reason,
          failingOutput: 'the failure',
          snapshot: emptySnapshot(),
          changedFiles: [],
        },
      );

      expect('error' in result).toBe(true);
      if (!('error' in result)) throw new Error('expected a seat-protocol error');
      expect(result.error.kind).toBe('seat-protocol-error');
      expect(result.error.message).toContain('after 2 attempt(s)');
      expect(result.error.data.errors).toContain('a rewrite-task must keep the task id T003');
      expect(planner.prompts).toHaveLength(2);
    },
  );

  it('repairs a split of a subtask once, naming the violation', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const { bus } = makeBusRecorder();
    const planner = consultPlanner([splitAnswer(null), guidanceAnswer('Answer', null)], true);
    const subtask = makeTask({
      id: 'T003',
      parentId: taskId('T002'),
      status: 'failed',
      revision: 1,
      criteria: ['C1'],
    });
    const state = { ...consultState(), tasks: [subtask] };
    saveState({ projectDir, sessionId }, state);

    const result = await requestConsult(
      {
        projectDir,
        workspaceDir: projectDir,
        sessionId,
        bus,
        config,
        planner: planner.planner,
        reviewer: planner.planner,
        state,
      },
      {
        task: subtask,
        reason: 'failed',
        failingOutput: 'the failure',
        snapshot: emptySnapshot(),
        changedFiles: [],
      },
    );

    expect('answer' in result).toBe(true);
    expect(planner.prompts).toHaveLength(2);
    expect(planner.prompts[1]).toContain(
      'T003 is already a subtask of a split and cannot be split again',
    );
  });

  it('retries a thrown transient call and rethrows the same error after the last retry', async () => {
    vi.useFakeTimers();
    const { projectDir, sessionId } = setupProject(dirs);
    const { bus } = makeBusRecorder();
    const failure = new Error('read ECONNRESET');
    let calls = 0;
    const planner: Pick<Planner, 'capabilities' | 'typedCall'> = {
      capabilities: {
        supportsConversationalPlanning: false,
        supportsSessionResume: true,
        supportsEffort: false,
        supportsImages: false,
        supportsSelfSummarisation: false,
      },
      typedCall: (ctx: TypedCallContext): TypedSeatCall => ({
        seat: ctx.seat,
        typedOutput: 'fallback',
        canResume: true,
        invoke: async () => {
          calls += 1;
          throw failure;
        },
      }),
    };
    const state = consultState();
    saveState({ projectDir, sessionId }, state);

    const pending = requestConsult(
      {
        projectDir,
        workspaceDir: projectDir,
        sessionId,
        bus,
        config,
        planner,
        reviewer: planner,
        state,
      },
      {
        task: state.tasks[0]!,
        reason: 'failed',
        failingOutput: 'the failure',
        snapshot: emptySnapshot(),
        changedFiles: [],
      },
    );
    let settled = false;
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    while (!settled) {
      await vi.advanceTimersByTimeAsync(vi.getTimerCount() === 0 ? 1 : 4_000);
    }

    await expect(pending).rejects.toBe(failure);
    expect(calls).toBe(4);
  });
});

describe('consultSeat', () => {
  it.each([
    {
      name: 'a plan task that failed',
      task: makeTask({ id: 'T003' }),
      reason: 'failed',
      seat: 'plan',
    },
    {
      name: 'a fix task that failed',
      task: makeTask({ id: 'T003', fix: FIX }),
      reason: 'failed',
      seat: 'review',
    },
    {
      name: 'a fix task that is blocked',
      task: makeTask({ id: 'T003', fix: FIX }),
      reason: 'blocked',
      seat: 'review',
    },
    {
      name: 'a fix task that went stale',
      task: makeTask({ id: 'T003', fix: FIX }),
      reason: 'stale',
      seat: 'review',
    },
    {
      name: 'a fix task that deviated',
      task: makeTask({ id: 'T003', fix: FIX }),
      reason: 'deviation',
      seat: 'plan',
    },
    {
      name: 'a rewrite of a fix task',
      task: makeTask({ id: 'T003', fix: FIX, revision: 2 }),
      reason: 'failed',
      seat: 'review',
    },
  ] as const)('routes $name to the $seat seat', ({ task, reason, seat }) => {
    expect(consultSeat(task, reason)).toBe(seat);
  });
});

describe('requestConsult seats', () => {
  function seatCtx(
    projectDir: string,
    sessionId: string,
    state: WorkflowState,
    planner: Pick<Planner, 'capabilities' | 'typedCall'>,
    reviewer: Pick<Planner, 'typedCall'>,
    seen: WorkflowState[],
  ): ConsultContext {
    const { bus } = makeBusRecorder();
    return {
      projectDir,
      workspaceDir: projectDir,
      sessionId,
      bus,
      config,
      planner,
      reviewer,
      state,
      onStateChange: (next) => seen.push(next),
    };
  }

  function request(task: Task, reason: 'failed' | 'deviation') {
    return {
      task,
      reason,
      failingOutput: 'the fix check is still red',
      snapshot: emptySnapshot(),
      changedFiles: [],
      ...(reason === 'deviation' && {
        report: {
          status: 'done' as const,
          filesChanged: [],
          touchedNotSuggested: [],
          notes: null,
          decisions: [{ what: 'Used node:crypto', why: 'It is standard' }],
        },
      }),
    };
  }

  function confirmAnswer(): ScriptedConsult {
    return {
      text: JSON.stringify({
        answer: { diagnosis: 'A change of how.', action: 'confirm', decisions: [] },
      }),
    };
  }

  it('asks the reviewer about a failed fix task with the full prompt and books its usage', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const planner = consultPlanner([], true);
    const reviewer = consultPlanner([guidanceAnswer('The fix missed a key', 'native-r')], false);
    const state = { ...fixState(), plannerSessionId: 'native-p' };
    saveState({ projectDir, sessionId }, state);
    const seen: WorkflowState[] = [];
    const ctx = seatCtx(projectDir, sessionId, state, planner.planner, reviewer.planner, seen);
    const events = makeBusRecorder();
    const task = state.tasks[0]!;

    const result = await requestConsult({ ...ctx, bus: events.bus }, request(task, 'failed'));

    expect('answer' in result).toBe(true);
    expect(planner.prompts).toHaveLength(0);
    expect(reviewer.contexts.map((context) => context.seat)).toEqual(['reviewer']);
    const prompt = reviewer.prompts[0]!;
    expect(prompt).toContain('# Consult on a failing task');
    expect(prompt).toContain('## Plan');
    expect(prompt).toContain('## Task T003 (revision 1)');
    expect(prompt).toContain("You are the run's reviewer");
    expect(prompt).toContain(
      '- **F1** failure keys: V1: greet > hello; red keys: V1: greet > name',
    );
    const after = seen.at(-1)!;
    expect(after.lineages?.T003?.consultRecords.at(-1)?.seat).toBe('review');
    expect(after.tokenUsage.reviewerInput).toBe(10);
    expect(after.tokenUsage.reviewerOutput).toBe(5);
    expect(after.tokenUsage.plannerInput).toBe(0);
    expect(after.plannerSessionId).toBe('native-p');
    const answered = events.events.find((event) => event.type === 'consult_answered');
    expect(answered).toMatchObject({ seat: 'review', taskId: 'T003' });
  });

  it('asks the planner about a failed plan task', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const planner = consultPlanner([guidanceAnswer('Answer', null)], true);
    const reviewer = consultPlanner([], false);
    const state = consultState();
    saveState({ projectDir, sessionId }, state);
    const seen: WorkflowState[] = [];
    const ctx = seatCtx(projectDir, sessionId, state, planner.planner, reviewer.planner, seen);

    await requestConsult(ctx, request(state.tasks[0]!, 'failed'));

    expect(reviewer.prompts).toHaveLength(0);
    expect(planner.contexts.map((context) => context.seat)).toEqual(['planner']);
    expect(planner.prompts[0]).toContain("You are the run's planner.");
    const after = seen.at(-1)!;
    expect(after.lineages?.T003?.consultRecords.at(-1)?.seat).toBe('plan');
    expect(after.tokenUsage.plannerInput).toBe(10);
    expect(after.tokenUsage.reviewerInput).toBe(0);
  });

  it('keeps a fix task deviation on the planner', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const planner = consultPlanner([confirmAnswer()], true);
    const reviewer = consultPlanner([], false);
    const state = fixState();
    saveState({ projectDir, sessionId }, state);
    const seen: WorkflowState[] = [];
    const ctx = seatCtx(projectDir, sessionId, state, planner.planner, reviewer.planner, seen);

    const result = await requestConsult(ctx, request(state.tasks[0]!, 'deviation'));

    expect('answer' in result).toBe(true);
    expect(reviewer.prompts).toHaveLength(0);
    expect(planner.contexts.map((context) => context.seat)).toEqual(['planner']);
    expect(seen.at(-1)?.lineages?.T003?.consultRecords.at(-1)?.seat).toBe('plan');
  });

  it('lets one planner object answer both seats when no reviewer is configured', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const planner = consultPlanner(
      [guidanceAnswer('Plan answer', null), guidanceAnswer('Fix answer', null)],
      false,
    );
    const planTask = makeTask({ id: 'T003', status: 'failed', revision: 1, criteria: ['C1'] });
    const fixTask = makeTask({
      id: 'T004',
      status: 'failed',
      revision: 1,
      criteria: ['C1'],
      fix: FIX,
    });
    const state = { ...consultState(), tasks: [planTask, fixTask] };
    saveState({ projectDir, sessionId }, state);
    const seen: WorkflowState[] = [];
    const ctx = seatCtx(projectDir, sessionId, state, planner.planner, planner.planner, seen);

    await requestConsult(ctx, request(planTask, 'failed'));
    await requestConsult({ ...ctx, state: seen.at(-1)! }, request(fixTask, 'failed'));

    expect(planner.contexts.map((context) => context.seat)).toEqual(['planner', 'reviewer']);
    const after = seen.at(-1)!;
    expect(after.lineages?.T003?.consultRecords.at(-1)?.seat).toBe('plan');
    expect(after.lineages?.T004?.consultRecords.at(-1)?.seat).toBe('review');
  });

  it('spends the one shared consult allowance from both seats', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const planner = consultPlanner([guidanceAnswer('Plan answer', null)], false);
    const reviewer = consultPlanner([guidanceAnswer('Fix answer', null)], false);
    const planTask = makeTask({ id: 'T003', status: 'failed', revision: 1, criteria: ['C1'] });
    const fixTask = makeTask({
      id: 'T004',
      status: 'failed',
      revision: 1,
      criteria: ['C1'],
      fix: FIX,
    });
    const state = { ...consultState(), tasks: [planTask, fixTask] };
    saveState({ projectDir, sessionId }, state);
    const seen: WorkflowState[] = [];
    const ctx = seatCtx(projectDir, sessionId, state, planner.planner, reviewer.planner, seen);

    await requestConsult(ctx, request(planTask, 'failed'));
    expect(seen.at(-1)?.plannerCalls?.used).toBe(1);
    await requestConsult({ ...ctx, state: seen.at(-1)! }, request(fixTask, 'failed'));
    expect(seen.at(-1)?.plannerCalls?.used).toBe(2);
  });

  it('rethrows a thrown reviewer consult unchanged and names the review seat', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const planner = consultPlanner([], true);
    const failure = new Error('the reviewer process stopped unexpectedly');
    const reviewer: Pick<Planner, 'typedCall'> = {
      typedCall: (ctx: TypedCallContext): TypedSeatCall => ({
        seat: ctx.seat,
        typedOutput: 'fallback',
        canResume: false,
        invoke: async () => {
          throw failure;
        },
      }),
    };
    const state = fixState();
    saveState({ projectDir, sessionId }, state);
    const ctx = seatCtx(projectDir, sessionId, state, planner.planner, reviewer, []);

    await expect(requestConsult(ctx, request(state.tasks[0]!, 'failed'))).rejects.toBe(failure);
    expect(thrownConsultSeat(failure)).toBe('review');
    expect(thrownConsultSeat(new Error('never thrown'))).toBeUndefined();
    const taskId = state.tasks[0]!.id;
    expect(retryFailureLabel(failure, taskId)).toBe(`Reviewer consult for ${taskId} failed`);
    expect(retryFailureLabel(new Error('never thrown'), taskId)).toBe(`Retrying ${taskId} failed`);
    expect(planner.prompts).toHaveLength(0);
  });
});
