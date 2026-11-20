import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makePreparedExecution } from '#testing/helpers/factories/prepared-execution.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { TEST_WORKFLOW_SINKS } from '#testing/helpers/orchestrator-context.js';
import {
  makeCallbacks,
  makeImplementer,
  makePlanner,
} from '#testing/helpers/orchestrator-factories.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { runTrackedWorkflow, settleTrackedWorkflows } from '#testing/helpers/tracked-workflow.js';
import {
  guidanceConsult,
  planFromTasks,
  typedCallPlanAndConsult,
} from '#testing/helpers/typed-planner.js';
import { seedValidationProject } from '#testing/helpers/validation-project.js';
import type { EngineEvent } from '../../events/types.js';
import type { ImplementerOptions, RetryOptions } from '../../implementers/types.js';

const TARGET_FILE = 'src/loop.ts';
const dirs: string[] = [];

beforeEach(() => {
  resetAllStores();
});

afterEach(async () => {
  await settleTrackedWorkflows();
  while (dirs.length > 0) cleanupTempDir(dirs.pop() as string);
});

function writeLoop(projectDir: string, marker: string): void {
  mkdirSync(join(projectDir, 'src'), { recursive: true });
  writeFileSync(join(projectDir, TARGET_FILE), `export const loop = "${marker}";\n`, 'utf-8');
}

describe('the consult with REVIEW None', { timeout: 90_000 }, () => {
  it('None consults the planner', async () => {
    const config = makeConfig({
      reviewer: 'none',
      implementer: {
        kind: 'agent',
        command: 'node',
        model: 'cheap-direct-agent',
        contextLength: 4096,
      },
      validation: { testCommand: 'node validate.mjs' },
      workflow: { approve: 'none' },
    });
    const projectDir = createTempDir('none-consult');
    dirs.push(projectDir);
    createTestGitRepo(projectDir);
    seedValidationProject(projectDir);
    const task = makeTask({
      id: 'T001',
      action: 'create',
      suggestedFiles: [TARGET_FILE],
      checks: [{ id: 'K-retry', kind: 'test', value: TARGET_FILE }],
      scope: { inBounds: [TARGET_FILE], outOfBounds: ['unrelated files'] },
      evidence: ['validation fails once, the consult-guided retry passes'],
      typeDefs: 'export const loop: string',
    });
    let consults = 0;
    const planner = makePlanner({
      typedCall: typedCallPlanAndConsult(
        () => planFromTasks([task]),
        () => {
          consults += 1;
          return guidanceConsult('Use the from-retry marker from validate.mjs.');
        },
      ),
    });
    const implementer = makeImplementer({
      capabilities: { writesFiles: 'direct' },
      implement: vi.fn().mockImplementation(async (call: ImplementerOptions) => {
        writeLoop(call.projectDir, 'from-initial');
        return { success: true, output: 'created', usage: { inputTokens: 50, outputTokens: 20 } };
      }),
      retry: vi.fn().mockImplementation(async (call: RetryOptions) => {
        writeLoop(call.projectDir, 'from-retry');
        return { success: true, output: 'fixed', usage: { inputTokens: 35, outputTokens: 15 } };
      }),
    });
    const events: EngineEvent[] = [];

    await runTrackedWorkflow({
      prepared: makePreparedExecution({
        projectDir,
        sessionId: 'sess-none-consult',
        feature: 'consult with no review seat',
        config,
      }),
      callbacks: makeCallbacks().callbacks,
      sinks: TEST_WORKFLOW_SINKS,
      _planner: planner,
      _implementer: implementer,
      _eventSink: (event) => events.push(event),
    });

    expect(consults).toBe(1);
    expect(implementer.retry).toHaveBeenCalledTimes(1);
    expect(events.find((event) => event.type === 'consult_answered')).toMatchObject({
      action: 'guidance',
    });
    expect(planner.review).not.toHaveBeenCalled();
    expect(events.find((event) => event.type === 'workflow_complete')).toMatchObject({
      review: 'none',
    });
  });
});
