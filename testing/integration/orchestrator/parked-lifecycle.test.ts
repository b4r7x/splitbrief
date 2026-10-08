import { sha256Hex } from '../../../src/utils/sha256.js';
import { readEvidenceLedger } from '../../../src/core/evidence/ledger-storage.js';
import { afterEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { makeNoValidationConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplStateWithMetadata } from '#testing/helpers/factories/workflow-state.js';
import {
  makeCopyingIsolation,
  makeImplementer,
  makePlanner,
  makeWctx,
} from '#testing/helpers/orchestrator-factories.js';
import { consultCallAnswering, guidanceConsult } from '#testing/helpers/typed-planner.js';
import { ensureSessionDir } from '../../../src/core/paths-io.js';
import { loadState } from '../../../src/core/state/persistence.js';
import { WORKFLOW_USER_CANCELLED_ABORT_REASON } from '../../../src/engine/events/workflow-cancel.js';
import { runSingleTask } from '../../../src/engine/orchestrator/task/step.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const projectDir = mkdtempSync(join(tmpdir(), 'validator-retention-'));
  roots.push(projectDir);
  execFileSync('git', ['init', '--quiet'], { cwd: projectDir });
  const sessionId = 'retention';
  ensureSessionDir(projectDir, sessionId);
  const task = makeTask({ suggestedFiles: ['partial.ts'] });
  const state = makeImplStateWithMetadata([task]);
  const config = makeNoValidationConfig({
    approval: { feedRejectionsToPlanner: false },
  });
  return { projectDir, sessionId, task, state, config };
}

it.each(['returned', 'thrown', 'success'] as const)(
  'keeps partial bytes when a local retry is stopped: %s',
  async (kind) => {
    const f = fixture();
    const stop = new AbortController();
    let retryWorkspace = '';
    let retryAttempt = -1;
    const stopped = await runSingleTask({
      wctx: makeWctx({
        ...f,
        isolation: makeCopyingIsolation({ projectDir: f.projectDir, sessionId: f.sessionId }),
        signal: stop.signal,
        implementer: makeImplementer({
          capabilities: { writesFiles: 'direct' },
          implement: vi.fn(async () => ({
            success: false,
            output: '',
            error: 'first call failed',
          })),
          retry: vi.fn(async (opts) => {
            retryWorkspace = opts.projectDir;
            retryAttempt = opts.attempt;
            roots.push(dirname(retryWorkspace));
            writeFileSync(join(retryWorkspace, 'partial.ts'), 'valuable retry partial');
            stop.abort();
            if (kind === 'thrown') throw new DOMException('Stopped', 'AbortError');
            return {
              success: kind === 'success',
              output: '',
              ...(kind === 'success' ? {} : { outcome: 'user-abort' as const }),
            };
          }),
        }),
      }),
      task: f.task,
      state: f.state,
      index: 0,
      totalTasks: 1,
      taskBreakdowns: [],
      setTrackedState: () => {},
      setCurrentTask: () => {},
    });
    console.log(
      JSON.stringify({
        case: `retry-${kind}`,
        retryAttempt,
        returnedAttempt: stopped.attempt,
        persistedAttempt: loadState(f)?.attempt,
        workspaceExists: existsSync(retryWorkspace),
        partialExists: existsSync(join(retryWorkspace, 'partial.ts')),
      }),
    );
    expect(retryAttempt).toBe(1);
    expect(existsSync(join(retryWorkspace, 'partial.ts'))).toBe(true);
    expect(stopped.attempt).toBe(retryAttempt);
    expect(existsSync(join(f.projectDir, '.git/index'))).toBe(false);
  },
);

it.each(['initial', 'local', 'consult'] as const)(
  'keeps a successful %s writer when Stop arrives during pre-promotion approval',
  async (route) => {
    const f = fixture();
    const stop = new AbortController();
    let workspace = '';
    let approvals = 0;
    const config = makeNoValidationConfig({
      approval: {
        feedRejectionsToPlanner: false,
      },
    });
    const writeResult = async (opts: { projectDir: string }) => {
      workspace = opts.projectDir;
      writeFileSync(join(workspace, '.env.local'), 'complete before approval');
      return { success: true, output: '' };
    };
    const wctx = makeWctx({
      ...f,
      isolation: makeCopyingIsolation({ projectDir: f.projectDir, sessionId: f.sessionId }),
      config,
      signal: stop.signal,
      planner: makePlanner({
        typedCall: consultCallAnswering(() => guidanceConsult('Write the protected file.')),
      }),
      implementer: makeImplementer({
        capabilities: { writesFiles: 'direct' },
        implement: async (opts) =>
          route === 'initial'
            ? writeResult(opts)
            : { success: false, output: '', error: 'initial failure' },
        retry: async (opts) =>
          route === 'consult' && opts.kind === 'local'
            ? { success: false, output: '', error: 'the local retry needs the planner' }
            : writeResult(opts),
      }),
    });
    wctx.callbacks.onTieredApproval = async () => {
      approvals += 1;
      stop.abort();
      return { decision: 'confirm', phrase: 'I confirm', reason: 'fixture approval' };
    };
    const stopped = await runSingleTask({
      wctx,
      task: f.task,
      state: f.state,
      index: 0,
      totalTasks: 1,
      taskBreakdowns: [],
      setTrackedState: () => {},
      setCurrentTask: () => {},
    });
    console.log(
      JSON.stringify({
        case: 'stop-during-approval',
        approvals,
        workspaceExists: existsSync(workspace),
        partialExists: existsSync(join(workspace, '.env.local')),
        targetExists: existsSync(join(f.projectDir, '.env.local')),
        attempt: stopped.attempt,
      }),
    );
    expect(approvals).toBe(1);
    expect(existsSync(join(f.projectDir, '.env.local'))).toBe(false);
    expect(existsSync(join(workspace, '.env.local'))).toBe(true);
  },
);

it.each(['returned', 'thrown', 'success'] as const)(
  'retains a silent initial worker on Stop: %s',
  async (kind) => {
    const f = fixture();
    const stop = new AbortController();
    let workspace = '';
    const wctx = makeWctx({
      ...f,
      isolation: makeCopyingIsolation({ projectDir: f.projectDir, sessionId: f.sessionId }),
      signal: stop.signal,
      implementer: makeImplementer({
        capabilities: { writesFiles: 'direct' },
        implement: async (opts) => {
          workspace = opts.projectDir;
          writeFileSync(join(workspace, 'partial.ts'), 'initial work');
          stop.abort();
          if (kind === 'thrown') throw new DOMException('Stopped', 'AbortError');
          return { success: kind === 'success', output: '', outcome: 'user-abort' };
        },
      }),
    });
    const state = await runSingleTask({
      wctx,
      task: f.task,
      state: f.state,
      index: 0,
      totalTasks: 1,
      taskBreakdowns: [],
      setTrackedState: () => {},
      setCurrentTask: () => {},
    });
    await wctx.isolation.dispose();
    expect(readFileSync(join(workspace, 'partial.ts'), 'utf8')).toBe('initial work');
    expect(existsSync(join(f.projectDir, 'partial.ts'))).toBe(false);
    expect(state.attempt).toBe(0);
  },
);

it.each(['returned', 'thrown', 'success'] as const)(
  'retains the stopped consult retry and its attempt: %s',
  async (kind) => {
    const f = fixture();
    const stop = new AbortController();
    let workspace = '';
    let attempt = -1;
    const wctx = makeWctx({
      ...f,
      isolation: makeCopyingIsolation({ projectDir: f.projectDir, sessionId: f.sessionId }),
      signal: stop.signal,
      planner: makePlanner({
        typedCall: consultCallAnswering(() => guidanceConsult('Write the partial file.')),
      }),
      implementer: makeImplementer({
        capabilities: { writesFiles: 'direct' },
        implement: async () => ({
          success: false,
          output: '',
          error: 'first call failed',
        }),
        retry: async (opts) => {
          if (opts.kind === 'local') {
            return { success: false, output: '', error: 'the local retry needs the planner' };
          }
          workspace = opts.projectDir;
          attempt = opts.attempt;
          writeFileSync(join(workspace, 'partial.ts'), 'consult retry work');
          stop.abort();
          if (kind === 'thrown') throw new DOMException('Stopped', 'AbortError');
          return { success: kind === 'success', output: '', outcome: 'user-abort' };
        },
      }),
    });
    const state = await runSingleTask({
      wctx,
      task: f.task,
      state: f.state,
      index: 0,
      totalTasks: 1,
      taskBreakdowns: [],
      setTrackedState: () => {},
      setCurrentTask: () => {},
    });
    await wctx.isolation.dispose();
    expect(readFileSync(join(workspace, 'partial.ts'), 'utf8')).toBe('consult retry work');
    expect(state.attempt).toBe(attempt);
    expect(loadState(f)?.attempt).toBe(attempt);
    expect(existsSync(join(f.projectDir, 'partial.ts'))).toBe(false);
  },
);

it.each(['end', 'failure'] as const)('discards initial output for %s', async (kind) => {
  const f = fixture();
  const stop = new AbortController();
  let workspace = '';
  const wctx = makeWctx({
    ...f,
    isolation: makeCopyingIsolation({ projectDir: f.projectDir, sessionId: f.sessionId }),
    signal: stop.signal,
    implementer: makeImplementer({
      capabilities: { writesFiles: 'direct' },
      implement: async (opts) => {
        workspace = opts.projectDir;
        writeFileSync(join(workspace, 'partial.ts'), 'discarded output');
        stop.abort(kind === 'end' ? WORKFLOW_USER_CANCELLED_ABORT_REASON : undefined);
        return kind === 'failure'
          ? { success: false, output: '', error: 'ordinary error' }
          : { success: true, output: '' };
      },
    }),
  });
  await runSingleTask({
    wctx,
    task: f.task,
    state: f.state,
    index: 0,
    totalTasks: 1,
    taskBreakdowns: [],
    setTrackedState: () => {},
    setCurrentTask: () => {},
  });
  await wctx.isolation.dispose();
  expect(existsSync(workspace)).toBe(true);
  expect(existsSync(join(workspace, 'partial.ts'))).toBe(false);
});

it('leaves a partial API application on its receipt and recovery path during Stop', async () => {
  const f = fixture();
  const stop = new AbortController();
  const content = 'applied API prefix';
  const task = { ...f.task, files: ['partial.ts', 'untouched.ts'] };
  const state = { ...f.state, tasks: [task] };
  const wctx = makeWctx({
    ...f,
    isolation: makeCopyingIsolation({ projectDir: f.projectDir, sessionId: f.sessionId }),
    signal: stop.signal,
    implementer: makeImplementer({
      capabilities: { writesFiles: 'extracted-code' },
      implement: async () => {
        writeFileSync(join(f.projectDir, 'partial.ts'), content, { mode: 0o600 });
        stop.abort();
        return {
          success: false,
          output: '',
          outcome: 'user-abort',
          applyResult: {
            callId: 'partial-api',
            candidatePaths: ['partial.ts', 'untouched.ts'],
            status: 'partial',
            code: 'io-failure',
            error: 'stopped before second file',
            failedPath: 'untouched.ts',
            applied: [
              {
                path: 'partial.ts',
                action: 'create',
                beforeSha256: null,
                afterSha256: sha256Hex(content),
                afterMode: 0o600,
                diff: '+applied API prefix',
                linesAdded: 1,
                linesRemoved: 0,
              },
            ],
            noops: [],
            untouched: ['untouched.ts'],
          },
        };
      },
    }),
  });
  const stopped = await runSingleTask({
    wctx,
    task,
    state,
    index: 0,
    totalTasks: 1,
    taskBreakdowns: [],
    setTrackedState: () => {},
    setCurrentTask: () => {},
  });
  expect(stopped.pendingRecovery).toBeDefined();
  expect(readFileSync(join(f.projectDir, 'partial.ts'), 'utf8')).toBe(content);
  expect(existsSync(join(f.projectDir, 'untouched.ts'))).toBe(false);
  expect(
    readEvidenceLedger(f)?.tasks.find((entry) => entry.id === task.id)?.apiApply,
  ).toMatchObject({ status: 'partial', untouched: ['untouched.ts'] });
});
