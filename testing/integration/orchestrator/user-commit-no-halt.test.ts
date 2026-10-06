import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadState } from '../../../src/core/state/persistence.js';
import { deriveRunStatus } from '../../../src/core/sessions/run-status.js';
import { createEventBus } from '../../../src/engine/events/bus.js';
import type { EngineEvent } from '../../../src/engine/events/types.js';
import type { ImplementerOptions } from '../../../src/engine/implementers/types.js';
import { runWorkflow } from '../../../src/engine/orchestrator/run/workflow.js';
import { makeNoValidationConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makePreparedExecution } from '#testing/helpers/factories/prepared-execution.js';
import {
  makeCallbacks,
  makeImplementer,
  makePlanner,
  TEST_SINKS,
} from '#testing/helpers/orchestrator-factories.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import {
  passingReviewVerdict,
  planFromTasks,
  typedCallPlanAndReview,
} from '#testing/helpers/typed-planner.js';

const TASKS = [
  makeTask({
    id: 'T001',
    action: 'modify',
    suggestedFiles: ['src/first.ts'],
    scope: { inBounds: ['src/first.ts'], outOfBounds: ['every other file'] },
    evidence: ['src/first.ts exports first'],
  }),
  makeTask({
    id: 'T002',
    action: 'modify',
    suggestedFiles: ['src/second.ts'],
    dependsOn: ['T001'],
    scope: { inBounds: ['src/second.ts'], outOfBounds: ['every other file'] },
    evidence: ['src/second.ts exports second'],
  }),
];

const dirs: string[] = [];

beforeEach(() => resetAllStores());

afterEach(() => {
  while (dirs.length > 0) cleanupTempDir(dirs.pop() as string);
});

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
}

describe('user commits during a run', { timeout: 120_000 }, () => {
  it('cause no halt: the run builds every brief in its workspace and the commits stay in the checkout', async () => {
    const projectDir = createTempDir('orch-int-user-commit');
    dirs.push(projectDir);
    createTestGitRepo(projectDir, {
      'src/first.ts': 'export const first = 0;\n',
      'src/second.ts': 'export const second = 0;\n',
      'src/notes.ts': 'export const notes = 0;\n',
    });
    const sessionId = 'sess-user-commit';
    const ref = { projectDir, sessionId };
    const feature = 'two briefs while the owner commits';
    const config = makeNoValidationConfig({
      workflow: { approve: 'none', maxRetries: 1, isolation: 'worktree' },
      approval: { feedRejectionsToPlanner: false },
    });

    const userCommit = (file: string, content: string) => {
      writeFileSync(join(projectDir, file), content);
      git(projectDir, ['add', file]);
      git(projectDir, ['commit', '--quiet', '-m', `owner edits ${file}`]);
    };
    const callDirs: string[] = [];
    const implementer = makeImplementer({
      capabilities: { writesFiles: 'direct' },
      implement: vi.fn(async (opts: ImplementerOptions) => {
        callDirs.push(opts.projectDir);
        const path = join(opts.projectDir, opts.task.suggestedFiles[0]);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, `export const ${opts.task.id.toLowerCase()} = true;\n`);
        if (opts.task.id === 'T001') {
          userCommit('src/second.ts', 'export const second = "owner";\n');
          userCommit('src/notes.ts', 'export const notes = "owner";\n');
        }
        return { success: true, output: 'written', usage: { inputTokens: 10, outputTokens: 5 } };
      }),
      retry: vi.fn(async () => {
        throw new Error('no brief in this run needs a retry');
      }),
    });
    let reviewCalls = 0;
    const planner = makePlanner({
      typedCall: typedCallPlanAndReview(
        () => planFromTasks(TASKS),
        (prompt) => {
          reviewCalls += 1;
          return passingReviewVerdict(prompt);
        },
      ),
    });
    const bus = createEventBus();
    const events: EngineEvent[] = [];
    bus.subscribe((event) => events.push(event));

    await runWorkflow({
      prepared: makePreparedExecution({ ...ref, feature, config }),
      callbacks: makeCallbacks().callbacks,
      sinks: TEST_SINKS,
      eventBus: bus,
      _planner: planner,
      _implementer: implementer,
    });

    const final = loadState(ref);
    if (final === null) throw new Error('the run saved no state');
    const workspace = final.workspace;
    if (workspace === undefined) throw new Error('the run recorded no workspace');
    expect(workspace.kind).toBe('worktree');
    expect(events.filter((event) => event.type === 'recovery_prompted')).toEqual([]);
    expect(final.pendingRecovery).toBeUndefined();
    expect(final.tasks.map((task) => [task.id, task.status])).toEqual([
      ['T001', 'done'],
      ['T002', 'done'],
    ]);
    expect(new Set(callDirs)).toEqual(new Set([workspace.path]));
    expect(reviewCalls).toBe(1);
    expect(deriveRunStatus({ state: final, liveness: 'not-alive' })).toEqual({
      kind: 'ready-to-apply',
      override: false,
    });
    expect(readFileSync(join(projectDir, 'src/second.ts'), 'utf8')).toBe(
      'export const second = "owner";\n',
    );
    expect(readFileSync(join(workspace.path, 'src/second.ts'), 'utf8')).toBe(
      'export const t002 = true;\n',
    );
    expect(git(projectDir, ['log', '--format=%s']).split('\n').slice(0, 2)).toEqual([
      'owner edits src/notes.ts',
      'owner edits src/second.ts',
    ]);
  });
});
