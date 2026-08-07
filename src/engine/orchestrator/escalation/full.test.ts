import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureSessionDir } from '../../../core/paths-io.js';
import { ONE_SHOT_API_CAPS } from '../../planners/types.js';
import { createPlannerBase } from '../../planners/base.js';
import { getChangedFilesSnapshot } from '../approval/file-snapshots/capture.js';
import { createRunIsolation } from '../isolation/create.js';
import { createValidator } from '../validation/run.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { makeRunnerCallResult } from '#testing/helpers/factories/runner-call.js';
import { defaultContext, makeNoValidationConfig } from '#testing/helpers/factories/config.js';
import {
  makeBusRecorder,
  makeCallbacks,
  makeImplementer,
  TEST_METADATA,
  TEST_SINKS,
} from '#testing/helpers/orchestrator-factories.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { runFullTier } from './full.js';

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) cleanupTempDir(dir);
  dirs = [];
});

const TARGET = 'src/dirty.ts';
const FIRST_ATTEMPT = 'export const dirty = "written by the attempt that failed";\n';
const REWRITTEN = 'export const dirty = "rewritten by the tier-2 escalation";\n';

describe('runFullTier', () => {
  it('completes when the escalation rewrites the file the run worktree was already dirty in', {
    timeout: 60_000,
  }, async () => {
    const projectDir = createTempDir('full-tier-test');
    dirs.push(projectDir);
    createTestGitRepo(projectDir);
    const sessionId = 'sess-full-tier';
    ensureSessionDir(projectDir, sessionId);

    const task = makeTask({ id: 'T001', file: TARGET });
    const state = makeImplState([task], { phase: 'escalating' });
    // An api planner has no host CLI state to bridge into the sandbox.
    const config = makeNoValidationConfig({
      planner: {
        kind: 'api',
        provider: 'anthropic',
        apiBase: 'https://api.anthropic.com/v1',
        apiKey: 'test-key',
        model: 'claude-sonnet-4-6',
      },
      approval: { enabled: false, feedRejectionsToPlanner: false },
      workflow: {},
    });
    const { callbacks } = makeCallbacks();
    const { bus } = makeBusRecorder();
    const taskStartSnapshot = await getChangedFilesSnapshot(projectDir);
    const isolation = createRunIsolation({
      projectDir,
      sessionId,
      strategy: 'worktree',
      onFallback: () => {},
      onRetained: () => {},
    });

    try {
      // The attempt that failed validation wrote the file and had it promoted,
      // so the linked worktree is already dirty in the path tier 2 rewrites.
      const failed = await isolation.acquire({
        role: 'planner',
        config,
        writesFiles: 'direct',
      });
      mkdirSync(join(failed.projectDir, 'src'), { recursive: true });
      writeFileSync(join(failed.projectDir, TARGET), FIRST_ATTEMPT);
      mkdirSync(join(projectDir, 'src'), { recursive: true });
      writeFileSync(join(projectDir, TARGET), FIRST_ATTEMPT);
      failed.cleanup();

      const outcome = await runFullTier({
        ctx: {
          projectDir,
          sessionId,
          config,
          callbacks,
          bus,
          // The real file-mode planner escalation, not a stub: what it concludes
          // here is what a shipped agent planner gets.
          planner: createPlannerBase({
            invokePlan: async () => makeRunnerCallResult({ status: 'completed', text: '' }),
            invokeEscalate: async ({ projectDir: runDir }) => {
              writeFileSync(join(runDir, TARGET), REWRITTEN);
              return makeRunnerCallResult({ status: 'completed', text: 'rewrote src/dirty.ts' });
            },
            isAvailable: async () => true,
            capabilities: ONE_SHOT_API_CAPS,
            escalateFullMode: 'files',
          }),
          context: defaultContext,
          implementer: makeImplementer({ capabilities: { writesFiles: 'direct' } }),
          metadata: TEST_METADATA,
          sinks: TEST_SINKS,
          validator: createValidator(),
          isolation,
          taskStartSnapshot,
          dependsOnFiles: [],
        },
        task,
        state,
        lastError: 'validation failed',
        priorAttempts: 0,
      });

      expect(outcome.result).toMatchObject({ completed: true, method: 'escalated-full' });
      expect(readFileSync(join(projectDir, TARGET), 'utf-8')).toBe(REWRITTEN);
    } finally {
      await isolation.dispose();
    }
  });
});
