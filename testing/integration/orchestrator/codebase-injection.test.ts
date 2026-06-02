import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInitialState, transition } from '../../../src/core/state/machine.js';
import { ensureSessionDir } from '../../../src/core/paths-io.js';
import { runPlanningPhase } from '../../../src/engine/orchestrator/planning/run.js';
import { createEventBus } from '../../../src/engine/events/bus.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { makeCallbacks, makePlanner } from '#testing/helpers/orchestrator-factories.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import {
  makeWorkflowMetadata,
  TEST_WORKFLOW_SINKS,
} from '#testing/helpers/orchestrator-context.js';

const META = makeWorkflowMetadata('quick');
const dirs: string[] = [];

beforeEach(() => resetAllStores());
afterEach(() => {
  while (dirs.length) cleanupTempDir(dirs.pop() as string);
});

// Tiny .ts file so buildRepoMap has something non-empty to format. The test asserts
// the orchestrator propagates _some_ codebase context to the planner, not the exact
// content — the buildRepoMap output is covered by src/engine/codebase/repomap.test.ts.
function seedSourceFile(projectDir: string): void {
  writeFileSync(
    join(projectDir, 'sample.ts'),
    `export function greet(name: string): string { return 'hello ' + name; }\n`,
  );
}

describe('codebase context injection into planner', () => {
  it('passes codebaseContext to planner.quickPlan when codebase.enabled is true', async () => {
    const projectDir = createTempDir('orch-int-codebase-inj');
    dirs.push(projectDir);
    createTestGitRepo(projectDir);
    seedSourceFile(projectDir);
    const sessionId = 'sess-codebase-inj';
    ensureSessionDir(projectDir, sessionId);

    let capturedContext: string | undefined;
    const planner = makePlanner({
      quickPlan: vi.fn().mockImplementation(({ codebaseContext }) => {
        capturedContext = codebaseContext;
        return {
          spec: '',
          plan: '',
          tasks: [makeTask()],
          usage: { inputTokens: 50, outputTokens: 25 },
        };
      }),
    });
    const { callbacks } = makeCallbacks();
    const bus = createEventBus();
    const config = makeConfig({
      workflow: {
        mode: 'quick',
        autoApproveSpec: true,
        autoApprovePlan: true,
        persistTranscript: false,
      },
      codebase: { enabled: true, tokenBudget: 1000, cacheDir: '.diptych' },
    });

    let state = createInitialState('add bar feature');
    state = transition(state, { type: 'START' });

    await runPlanningPhase({
      wctx: {
        projectDir,
        sessionId,
        config,
        callbacks,
        bus,
        metadata: META,
        sinks: TEST_WORKFLOW_SINKS,
      },
      planner,
      state,
      feature: state.feature,
    });

    expect(typeof capturedContext).toBe('string');
    if (capturedContext === undefined)
      throw new Error('expected planner to receive codebase context');
    expect(capturedContext.length).toBeGreaterThan(0);
    expect(capturedContext).toContain('sample.ts');
  });

  it('passes undefined codebaseContext to planner.quickPlan when codebase.enabled is false', async () => {
    const projectDir = createTempDir('orch-int-codebase-disabled');
    dirs.push(projectDir);
    createTestGitRepo(projectDir);
    seedSourceFile(projectDir);
    const sessionId = 'sess-codebase-disabled';
    ensureSessionDir(projectDir, sessionId);

    let capturedContext: string | undefined = 'SENTINEL';
    const planner = makePlanner({
      quickPlan: vi.fn().mockImplementation(({ codebaseContext }) => {
        capturedContext = codebaseContext;
        return {
          spec: '',
          plan: '',
          tasks: [makeTask()],
          usage: { inputTokens: 50, outputTokens: 25 },
        };
      }),
    });
    const { callbacks } = makeCallbacks();
    const bus = createEventBus();
    const config = makeConfig({
      workflow: {
        mode: 'quick',
        autoApproveSpec: true,
        autoApprovePlan: true,
        persistTranscript: false,
      },
      codebase: { enabled: false, tokenBudget: 1000, cacheDir: '.diptych' },
    });

    let state = createInitialState('add baz feature');
    state = transition(state, { type: 'START' });

    await runPlanningPhase({
      wctx: {
        projectDir,
        sessionId,
        config,
        callbacks,
        bus,
        metadata: META,
        sinks: TEST_WORKFLOW_SINKS,
      },
      planner,
      state,
      feature: state.feature,
    });

    expect(capturedContext).toBeUndefined();
  });
});
