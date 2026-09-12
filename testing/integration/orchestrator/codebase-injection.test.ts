import { mkdirSync, writeFileSync } from 'node:fs';
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

interface PlanRunOpts {
  name: string;
  feature: string;
  enabled: boolean;
  preseedContext?: string;
  seedCache?: (projectDir: string) => void;
}

async function planWithCodebase(
  opts: PlanRunOpts,
): Promise<{ context: string | undefined; warnings: string[] }> {
  const projectDir = createTempDir(`orch-int-${opts.name}`);
  dirs.push(projectDir);
  createTestGitRepo(projectDir);
  seedSourceFile(projectDir);
  const sessionId = `sess-${opts.name}`;
  ensureSessionDir(projectDir, sessionId);
  opts.seedCache?.(projectDir);

  let context = opts.preseedContext;
  const planner = makePlanner({
    quickPlan: vi.fn().mockImplementation(({ codebaseContext }) => {
      context = codebaseContext;
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
  const warnings: string[] = [];
  bus.subscribe((event) => {
    if (event.type === 'warning') warnings.push(event.message);
  });
  const config = makeConfig({
    workflow: {
      mode: 'quick',
      approve: 'none',
    },
    codebase: { enabled: opts.enabled, tokenBudget: 1000 },
  });

  let state = createInitialState(opts.feature);
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

  return { context, warnings };
}

describe('codebase context injection into planner', { timeout: 90_000 }, () => {
  it('passes codebaseContext to planner.quickPlan when codebase.enabled is true', async () => {
    const { context } = await planWithCodebase({
      name: 'codebase-inj',
      feature: 'add bar feature',
      enabled: true,
    });

    if (context === undefined) throw new Error('expected planner to receive codebase context');
    expect(context.length).toBeGreaterThan(0);
    expect(context).toContain('sample.ts');
  });

  it('passes undefined codebaseContext to planner.quickPlan when codebase.enabled is false', async () => {
    const { context } = await planWithCodebase({
      name: 'codebase-disabled',
      feature: 'add baz feature',
      enabled: false,
      preseedContext: 'SENTINEL',
    });

    expect(context).toBeUndefined();
  });

  it('self-heals a corrupt repomap.sqlite and publishes a warning event instead of silently dropping it', async () => {
    const { context, warnings } = await planWithCodebase({
      name: 'codebase-corrupt',
      feature: 'add corrupt-cache feature',
      enabled: true,
      seedCache: (projectDir) => {
        mkdirSync(join(projectDir, '.splitbrief'), { recursive: true });
        writeFileSync(
          join(projectDir, '.splitbrief', 'repomap.sqlite'),
          'not a sqlite database — torn header garbage'.repeat(8),
        );
      },
    });

    expect(warnings.some((m) => m.includes('corrupt'))).toBe(true);
    if (context === undefined)
      throw new Error('expected planner to receive codebase context after self-heal');
    expect(context).toContain('sample.ts');
  });
});
