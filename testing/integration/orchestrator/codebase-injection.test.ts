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
import { resetAllStores } from '#testing/helpers/stores.js';

const SINKS = { setAbortHandler: () => {}, setQueueHandler: () => {} };
const META = { plannerTool: 'claude-code', implementerTool: 'ollama', mode: 'quick' as const };
const dirs: string[] = [];

beforeEach(() => resetAllStores());
afterEach(() => { while (dirs.length) cleanupTempDir(dirs.pop() as string); });

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

    const planner = makePlanner();
    const { callbacks } = makeCallbacks();
    const bus = createEventBus();
    const config = makeConfig({
      workflow: { mode: 'quick', autoApproveSpec: true, autoApprovePlan: true, persistTranscript: false },
      codebase: { enabled: true, tokenBudget: 1000, cacheDir: '.diptych' },
    });

    let state = createInitialState('add bar feature');
    state = transition(state, { type: 'START', feature: 'add bar feature' });

    await runPlanningPhase({
      wctx: { projectDir, sessionId, config, callbacks, bus, metadata: META, sinks: SINKS },
      planner,
      state,
      feature: state.feature,
    });

    const quickPlanCalls = vi.mocked(planner.quickPlan).mock.calls;
    expect(quickPlanCalls).toHaveLength(1);
    const codebaseContext = quickPlanCalls[0]?.[3];
    expect(typeof codebaseContext).toBe('string');
    expect((codebaseContext as string).length).toBeGreaterThan(0);
    // The repo-map includes the file header for discovered sources.
    expect(codebaseContext).toContain('sample.ts');
  });

  it('passes undefined codebaseContext to planner.quickPlan when codebase.enabled is false', async () => {
    const projectDir = createTempDir('orch-int-codebase-disabled');
    dirs.push(projectDir);
    createTestGitRepo(projectDir);
    seedSourceFile(projectDir);
    const sessionId = 'sess-codebase-disabled';
    ensureSessionDir(projectDir, sessionId);

    const planner = makePlanner();
    const { callbacks } = makeCallbacks();
    const bus = createEventBus();
    const config = makeConfig({
      workflow: { mode: 'quick', autoApproveSpec: true, autoApprovePlan: true, persistTranscript: false },
      codebase: { enabled: false, tokenBudget: 1000, cacheDir: '.diptych' },
    });

    let state = createInitialState('add baz feature');
    state = transition(state, { type: 'START', feature: 'add baz feature' });

    await runPlanningPhase({
      wctx: { projectDir, sessionId, config, callbacks, bus, metadata: META, sinks: SINKS },
      planner,
      state,
      feature: state.feature,
    });

    const quickPlanCalls = vi.mocked(planner.quickPlan).mock.calls;
    expect(quickPlanCalls).toHaveLength(1);
    expect(quickPlanCalls[0]?.[3]).toBeUndefined();
  });
});
