import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EngineEvent } from '../../../src/engine/events/types.js';
import type { ImplementerOptions, RetryOptions } from '../../../src/engine/implementers/types.js';
import type { Task } from '../../../src/core/schemas/task.js';
import type {
  RunValidationOptions,
  Validator,
} from '../../../src/engine/orchestrator/validation/types.js';
import { createValidator } from '../../../src/engine/orchestrator/validation/run.js';
import { runTaskLoop } from '../../../src/engine/orchestrator/task/loop.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { makeNoValidationConfig } from '#testing/helpers/factories/config.js';
import {
  makeBusRecorder,
  makeCallbacks,
  makeImplementer,
  makePlanner,
  makeWctx,
  openRunWorkspace,
} from '#testing/helpers/orchestrator-factories.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { setupGitSessionProject } from '#testing/helpers/git-session.js';
import { consultCallAnswering, guidanceConsult } from '#testing/helpers/typed-planner.js';

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) cleanupTempDir(dirs.pop() as string);
});

const DECISION = {
  what: 'Read the review record from schemas/workflow.ts',
  why: 'The brief named a module that does not export it',
};

describe('decision-confirm on the S6 shape', { timeout: 90_000 }, () => {
  it('confirms every hand-back, retries a red validation with its errors, and lands with no halt', async () => {
    const { projectDir, sessionId } = setupGitSessionProject({
      prefix: 'int-decision-confirm',
      sessionId: 'sess-decision-confirm',
    });
    dirs.push(projectDir);
    const tasks = ['T001', 'T002'].map((id) =>
      makeTask({ id, suggestedFiles: [`src/${id.toLowerCase()}.ts`] }),
    );

    // Every hand-back carries the same decision, as DeepSeek's did on every brief of S6.
    const handBack = (opts: ImplementerOptions, marker: string) => {
      mkdirSync(join(opts.projectDir, 'src'), { recursive: true });
      writeFileSync(join(opts.projectDir, opts.task.suggestedFiles[0]), `${marker}\n`);
      return {
        success: true,
        output: marker,
        usage: { inputTokens: 10, outputTokens: 5 },
        report: {
          status: 'done' as const,
          filesChanged: [opts.task.suggestedFiles[0]],
          touchedNotSuggested: [],
          notes: null,
          decisions: [DECISION],
        },
      };
    };
    const implementer = makeImplementer({
      implement: vi.fn(async (opts: ImplementerOptions) => handBack(opts, 'first attempt')),
      retry: vi.fn(async (opts: RetryOptions) => handBack(opts, 'retry')),
    });

    // T002's first validation fails once; everything else passes.
    const failure = 'src/t002.ts(3,1): error TS2304: Cannot find name ReviewRecord.';
    let t002Validations = 0;
    const validator: Validator = {
      ...createValidator(),
      runValidation: vi.fn(async (opts: RunValidationOptions) => {
        if (opts.task.id === 'T002' && t002Validations++ === 0) {
          return [{ stage: 'typecheck' as const, passed: false, error: failure }];
        }
        return [{ stage: 'typecheck' as const, passed: true }];
      }),
    };

    const prompts: string[] = [];
    const planner = makePlanner({
      typedCall: consultCallAnswering((prompt) => {
        prompts.push(prompt);
        return prompt.includes('deviation —')
          ? {
              answer: {
                diagnosis: 'A change of how.',
                action: 'confirm',
                decisions: [DECISION],
              },
            }
          : guidanceConsult();
      }),
    });

    const { bus, events } = makeBusRecorder();
    const wctx = await openRunWorkspace(
      makeWctx({
        projectDir,
        sessionId,
        config: makeNoValidationConfig(),
        callbacks: makeCallbacks({ onPlannerReply: vi.fn() }).callbacks,
        planner,
        implementer,
        validator,
        bus,
      }),
    );
    const initialState = makeImplState(tasks, {
      plan: { summary: 'S6', decisions: [], criteria: [], checks: [], validation: null },
      // The stale refresh already spent one consult on every lineage, as in S6.
      lineages: Object.fromEntries(
        tasks.map((task: Task) => [
          task.id,
          {
            consults: 1,
            attempts: 0,
            consultAllowance: 2,
            attemptAllowance: 8,
            staleConsultedRevision: { [task.id]: 1 },
            consultRecords: [],
            replacedParents: [],
            notes: [],
          },
        ]),
      ),
    });

    const result = await runTaskLoop({
      wctx,
      initialState,
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    expect(result.state.pendingRecovery).toBeUndefined();
    expect(result.status).toBe('complete');
    expect(result.state.tasks.map((task) => task.status)).toEqual(['done', 'done']);

    // T002 retried once with the exact compiler output; no consult and no bound halt ran.
    const retries = vi.mocked(implementer.retry).mock.calls.map(([opts]) => opts);
    expect(retries).toHaveLength(1);
    expect(retries[0]?.task.id).toBe('T002');
    expect(retries[0]?.error).toContain(failure);
    const types = events.map((event: EngineEvent) => event.type);
    expect(types).not.toContain('consult_bound_spent');
    expect(types).not.toContain('task_escalating');

    // The planner was asked once per brief to confirm, never to consult, and the
    // run's planner-call bound is untouched.
    expect(prompts).toHaveLength(2);
    expect(result.state.plan?.decisions).toEqual(
      tasks.map((task) => ({ text: `${DECISION.what} — ${DECISION.why}`, taskId: task.id })),
    );
    expect(prompts.every((prompt) => prompt.includes('deviation —'))).toBe(true);
    expect(result.state.plannerCalls?.used ?? 0).toBe(0);
    for (const task of tasks) expect(result.state.lineages?.[task.id]?.consults).toBe(1);
  });
});
