import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeRunnerCallResult } from '#testing/helpers/factories/runner-call.js';
import { makeBusRecorder } from '#testing/helpers/orchestrator-factories.js';
import { setupProject } from '#testing/helpers/planning-phase.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import type { ChangedFilesSnapshot, WorkflowState } from '../../../core/schemas/workflow.js';
import { createInitialState, transition } from '../../../core/state/machine.js';
import { saveState } from '../../../core/state/persistence.js';
import type { Planner, TypedCallContext } from '../../planners/types.js';
import type { TypedSeatCall } from '../../runners/typed-output.js';
import { requestConsult, type ConsultContext } from './request.js';

const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) cleanupTempDir(dir);
});

type ScriptedConsult = Readonly<{ text: string; nativeSessionId?: string | null }>;

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

function emptySnapshot(): ChangedFilesSnapshot {
  return { head: 'unused', files: [], dirtyFileContents: {} };
}

describe('requestConsult', () => {
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
      sessionId,
      bus,
      planner: planner.planner,
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
      sessionId,
      bus,
      planner: planner.planner,
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

  it('records a stale consult without spending a planner call', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const { bus } = makeBusRecorder();
    const planner = consultPlanner([guidanceAnswer('Inputs moved.', null)], true);
    const state = consultState();
    saveState({ projectDir, sessionId }, state);
    const seen: WorkflowState[] = [];

    const result = await requestConsult(
      {
        projectDir,
        sessionId,
        bus,
        planner: planner.planner,
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
    expect(after.lineages?.T003?.staleConsultedRevision).toEqual({ T003: 1 });
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
      { projectDir, sessionId, bus, planner: planner.planner, state },
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
      { projectDir, sessionId, bus, planner, state },
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
