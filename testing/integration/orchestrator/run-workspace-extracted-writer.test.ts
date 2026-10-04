import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadState } from '../../../src/core/state/persistence.js';
import type { ImplementerOptions, RetryOptions } from '../../../src/engine/implementers/types.js';
import { runWorkflow } from '../../../src/engine/orchestrator/run/workflow.js';
import { makeCallbacks, makePlanner } from '#testing/helpers/orchestrator-factories.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makePreparedExecution } from '#testing/helpers/factories/prepared-execution.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { TEST_WORKFLOW_SINKS } from '#testing/helpers/orchestrator-context.js';
import { typedCallFromTasks } from '#testing/helpers/typed-planner.js';
import { ensureConfigGitignore } from '../../../src/core/config/load/document.js';
import { createApiImplementer } from '../../../src/engine/implementers/api.js';
import { makeOpenAiSseResponse } from '#testing/helpers/faux/openai-sse.js';
import { withLocalCatalog } from '#testing/helpers/faux/local-catalog.js';
import { checkoutEntries } from '#testing/helpers/checkout.js';

const dirs: string[] = [];

beforeEach(() => resetAllStores());

afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of dirs.splice(0)) cleanupTempDir(dir);
});

function checkoutStatus(projectDir: string): string {
  return execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
    cwd: projectDir,
    encoding: 'utf8',
  });
}

describe('an extracted-code writer in the run workspace', { timeout: 90_000 }, () => {
  it('api first attempt, retry and stop/continue share one workspace and leave the checkout byte-identical', async () => {
    const projectDir = createTempDir('orch-int-run-workspace-api');
    dirs.push(projectDir);
    const original = 'export const value = 1;\n';
    createTestGitRepo(projectDir, { 'src/value.ts': original });
    ensureConfigGitignore(projectDir);
    const statusBefore = checkoutStatus(projectDir);
    const entriesBefore = checkoutEntries(projectDir);
    const sessionId = 'sess-run-workspace-api';
    const feature = 'one workspace for an api writer';
    const targetFile = 'src/value.ts';

    const task = makeTask({
      id: 'T001',
      action: 'modify',
      file: targetFile,
      title: 'Change the value',
      scope: { inBounds: [targetFile], outOfBounds: ['unrelated files'] },
      evidence: ['src/value.ts exports value 2'],
    });
    const config = makeConfig({
      validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
      workflow: { approve: 'none', maxRetries: 2 },
    });
    const planner = makePlanner({ typedCall: typedCallFromTasks([task]) });
    const callDirs: string[] = [];
    const contents = ['first attempt', 'retry', 'after continue'];
    let completionCalls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        withLocalCatalog(['qwen2.5-coder:7b'], () => {
          const content = `export const value = "${contents[completionCalls]}";\n`;
          completionCalls += 1;
          return makeOpenAiSseResponse([
            {
              content: JSON.stringify({
                version: 1,
                files: [{ path: targetFile, action: 'modify', content }],
              }),
            },
          ]);
        }),
      ),
    );
    const api = createApiImplementer(config);

    const stop = new AbortController();
    await runWorkflow({
      prepared: makePreparedExecution({ projectDir, sessionId, feature, config }),
      callbacks: makeCallbacks().callbacks,
      sinks: TEST_WORKFLOW_SINKS,
      signal: stop.signal,
      _planner: planner,
      _implementer: {
        ...api,
        implement: async (opts: ImplementerOptions) => {
          callDirs.push(opts.projectDir);
          const result = await api.implement(opts);
          expect(result.applyResult).toMatchObject({
            status: 'applied',
            applied: [{ path: targetFile }],
          });
          return { ...result, success: false, error: 'first attempt does not compile' };
        },
        retry: async (opts: RetryOptions) => {
          callDirs.push(opts.projectDir);
          const result = await api.retry(opts);
          expect(result.applyResult).toMatchObject({
            status: 'applied',
            applied: [{ path: targetFile }],
          });
          stop.abort();
          return { ...result, success: false, error: 'stopped', outcome: 'user-abort' };
        },
      },
    });

    const stopped = loadState({ projectDir, sessionId });
    const workspace = stopped?.workspace;
    expect(workspace?.kind).toBe('worktree');
    expect(workspace?.path).not.toBe(projectDir);
    expect(callDirs).toEqual([workspace?.path, workspace?.path]);
    if (stopped === null || workspace === undefined)
      throw new Error('Missing stopped run workspace');
    expect(readFileSync(join(workspace.path, targetFile), 'utf8')).toContain('retry');
    expect(readFileSync(join(projectDir, targetFile), 'utf8')).toBe(original);
    expect(checkoutStatus(projectDir)).toBe(statusBefore);
    expect(checkoutEntries(projectDir)).toEqual(entriesBefore);

    const again = new AbortController();
    const continueCall = async (opts: ImplementerOptions) => {
      callDirs.push(opts.projectDir);
      const result = await api.implement(opts);
      expect(result.applyResult).toMatchObject({
        status: 'applied',
        applied: [{ path: targetFile }],
      });
      again.abort();
      return {
        ...result,
        success: false,
        error: 'stopped',
        outcome: 'user-abort' as const,
      };
    };
    await runWorkflow({
      prepared: makePreparedExecution({
        projectDir,
        sessionId,
        feature,
        config,
        resumeState: stopped,
      }),
      savedState: stopped,
      callbacks: makeCallbacks().callbacks,
      sinks: TEST_WORKFLOW_SINKS,
      signal: again.signal,
      _planner: planner,
      _implementer: {
        ...api,
        implement: continueCall,
        retry: continueCall,
      },
    });

    expect(callDirs).toHaveLength(3);
    expect(new Set(callDirs)).toEqual(new Set([workspace.path]));
    expect(loadState({ projectDir, sessionId })?.workspace).toEqual(workspace);
    expect(readFileSync(join(workspace.path, targetFile), 'utf8')).toContain('after continue');
    expect(readFileSync(join(projectDir, targetFile), 'utf8')).toBe(original);
    expect(checkoutStatus(projectDir)).toBe(statusBefore);
    expect(checkoutEntries(projectDir)).toEqual(entriesBefore);
    expect(completionCalls).toBe(3);
  });
});
