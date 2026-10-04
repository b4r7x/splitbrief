import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { makeCallbacks, makeImplementer } from '#testing/helpers/orchestrator-factories.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeImplStateWithMetadata as implementingState } from '#testing/helpers/factories/workflow-state.js';
import {
  cleanupTaskProjects,
  makeTaskWorkflowContext,
  setupTaskProject,
} from '#testing/helpers/orchestrator-task-context.js';
import { makeOpenAiSseResponse } from '#testing/helpers/faux/openai-sse.js';
import { withLocalCatalog } from '#testing/helpers/faux/local-catalog.js';
import { CONFIRM_PHRASE } from '../../../core/approval/types.js';
import type { Config } from '../../../core/schemas/config.js';
import type { Task } from '../../../core/schemas/task.js';
import { readEvidenceLedger } from '../../../core/evidence/ledger-storage.js';
import type { Implementer, ImplementerOptions } from '../../implementers/types.js';
import { createAgentImplementer } from '../../implementers/agent.js';
import { createApiImplementer } from '../../implementers/api.js';
import { createShellImplementer } from '../../implementers/shell.js';
import {
  getChangedFilesSinceSnapshot,
  getChangedFilesSnapshot,
} from '../approval/file-snapshots/capture.js';
import { createRunIsolation } from '../isolation/create.js';
import { createValidator } from '../validation/run.js';
import { gateAttemptChanges } from './attempt-gate.js';
import { runSingleTask } from './step.js';

const SECRET = '.env.local';
const ORIGINAL = 'MODE=original\n';
const LEAKED = 'MODE=leaked\n';
const HELLO = 'src/hello.ts';
const HELLO_TEXT = 'export const hello = 1;\n';
const EARLIER = 'src/earlier.ts';
const EARLIER_TEXT = 'export const earlier = true;\n';

const BASE_CONFIG = {
  approval: { enabled: false, feedRejectionsToPlanner: true },
  validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
  workflow: { maxRetries: 2 },
} as const;

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const dispose of disposers.splice(0)) await dispose();
  cleanupTaskProjects();
});

function writeBoth(dir: string): void {
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, HELLO), HELLO_TEXT);
  writeFileSync(join(dir, SECRET), LEAKED);
}

function directWriter(): Implementer {
  const write = async ({ projectDir }: ImplementerOptions) => {
    writeBoth(projectDir);
    return { success: true as const, output: 'ok', usage: { inputTokens: 10, outputTokens: 5 } };
  };
  return makeImplementer({
    capabilities: { writesFiles: 'direct' },
    implement: vi.fn().mockImplementation(write),
    retry: vi.fn().mockImplementation(write),
  });
}

function bundleResponse(files: Array<{ path: string; action: string; content: string }>) {
  return makeOpenAiSseResponse([{ content: JSON.stringify({ version: 1, files }) }]);
}

type Transport = {
  name: 'cli' | 'agent' | 'api' | 'shell';
  /** The writer asks before it writes, so a denied file never lands and the brief does not finish. */
  confirmsBeforeWrite: boolean;
  task: Task;
  build: () => { config: Config; implementer: Implementer };
};

const helloTask = makeTask({
  id: 'T001',
  action: 'create',
  file: HELLO,
  files: [HELLO, SECRET],
  scope: { inBounds: [HELLO, SECRET] },
});

const TRANSPORTS: Transport[] = [
  {
    name: 'cli',
    confirmsBeforeWrite: false,
    task: helloTask,
    build: () => ({ config: makeConfig(BASE_CONFIG), implementer: directWriter() }),
  },
  {
    name: 'agent',
    confirmsBeforeWrite: false,
    task: helloTask,
    build: () => {
      const config = makeConfig({
        ...BASE_CONFIG,
        implementer: {
          model: 'test',
          contextLength: 8192,
          temperature: 0.3,
          kind: 'agent',
          command: 'bash',
          args: [
            '-c',
            `mkdir -p src && printf '${HELLO_TEXT.trimEnd()}\\n' > ${HELLO} && printf '${LEAKED.trimEnd()}\\n' > ${SECRET}`,
          ],
        },
      });
      return { config, implementer: createAgentImplementer(config) };
    },
  },
  {
    name: 'api',
    confirmsBeforeWrite: true,
    task: helloTask,
    build: () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(
          withLocalCatalog(['qwen2.5-coder:7b'], () =>
            bundleResponse([
              { path: HELLO, action: 'create', content: HELLO_TEXT },
              { path: SECRET, action: 'modify', content: LEAKED },
            ]),
          ),
        ),
      );
      const config = makeConfig(BASE_CONFIG);
      return { config, implementer: createApiImplementer(config) };
    },
  },
  {
    name: 'shell',
    confirmsBeforeWrite: true,
    task: makeTask({ id: 'T001', action: 'modify', file: SECRET, scope: { inBounds: [SECRET] } }),
    build: () => {
      const config = makeConfig({
        ...BASE_CONFIG,
        implementer: {
          model: 'test',
          contextLength: 8192,
          temperature: 0.3,
          kind: 'shell',
          command: '/bin/sh',
          args: ['-c', `cat >/dev/null; printf '\`\`\`\\n${LEAKED.trimEnd()}\\n\`\`\`\\n'`],
          outputFormat: 'text',
        },
      });
      return { config, implementer: createShellImplementer(config) };
    },
  },
];

async function runInWorkspace(opts: {
  task: Task;
  config: Config;
  implementer: Implementer;
  runValidation: ReturnType<typeof createValidator>['runValidation'];
  approve?: boolean;
}) {
  const { projectDir, sessionId } = setupTaskProject({ [SECRET]: ORIGINAL });
  const isolation = createRunIsolation({
    projectDir,
    sessionId,
    strategy: 'worktree',
    onFallback: () => {},
    onRetained: () => {},
  });
  disposers.push(() => isolation.dispose());
  const workspaceDir = (await isolation.open({ config: opts.config })).projectDir;
  // An earlier brief's accepted output, still only in the run workspace.
  mkdirSync(join(workspaceDir, 'src'), { recursive: true });
  writeFileSync(join(workspaceDir, EARLIER), EARLIER_TEXT);

  const onTieredApproval = vi
    .fn()
    .mockResolvedValue(
      opts.approve === true
        ? { decision: 'confirm', phrase: CONFIRM_PHRASE, reason: 'needed' }
        : { decision: 'deny', reason: 'no' },
    );
  const { callbacks } = makeCallbacks({ onTieredApproval });
  const state = await runSingleTask({
    wctx: makeTaskWorkflowContext({
      projectDir,
      sessionId,
      workspaceDir,
      callbacks,
      implementer: opts.implementer,
      config: opts.config,
      isolation,
      validator: { ...createValidator(), runValidation: opts.runValidation },
    }),
    task: opts.task,
    index: 0,
    totalTasks: 1,
    state: implementingState([opts.task]),
    taskBreakdowns: [],
    setTrackedState: vi.fn(),
    setCurrentTask: vi.fn(),
  });
  return { projectDir, sessionId, workspaceDir, state, onTieredApproval };
}

function read(dir: string, file: string): string {
  return readFileSync(join(dir, file), 'utf8');
}

describe('gateAttemptChanges', () => {
  it.each(TRANSPORTS)(
    '$name: protected file edited, approval denied, bytes restored before validation, earlier accepted changes kept',
    { timeout: 60_000 },
    async (transport) => {
      const seen: Array<{ secret: string; earlier: string }> = [];
      const runValidation = vi.fn().mockImplementation(async ({ projectDir }) => {
        seen.push({ secret: read(projectDir, SECRET), earlier: read(projectDir, EARLIER) });
        return [];
      });
      const { config, implementer } = transport.build();

      const run = await runInWorkspace({
        task: transport.task,
        config,
        implementer,
        runValidation,
      });

      expect(run.onTieredApproval).toHaveBeenCalledTimes(1);
      expect(run.onTieredApproval).toHaveBeenCalledWith(
        expect.objectContaining({ actionDescription: `write ${SECRET}` }),
      );
      expect(seen).toEqual(
        transport.confirmsBeforeWrite ? [] : [{ secret: ORIGINAL, earlier: EARLIER_TEXT }],
      );
      expect(read(run.workspaceDir, SECRET)).toBe(ORIGINAL);
      expect(read(run.workspaceDir, EARLIER)).toBe(EARLIER_TEXT);
      expect(read(run.projectDir, SECRET)).toBe(ORIGINAL);
      if (!transport.confirmsBeforeWrite) {
        expect(read(run.workspaceDir, HELLO)).toBe(HELLO_TEXT);
        expect(run.state.tasks[0]?.status).toBe('done');
      }
      expect(readEvidenceLedger(run)?.rejections).toContainEqual(
        expect.objectContaining({ actionDescription: `write ${SECRET}` }),
      );
    },
  );

  it.each(['cli', 'api'] as const)(
    "%s: a retry's protected write is gated after the write and restored before its validation",
    { timeout: 60_000 },
    async (name) => {
      let calls = 0;
      const attemptFiles = () => {
        calls += 1;
        return calls === 1
          ? [{ path: HELLO, action: 'create', content: 'export const hello = 0;\n' }]
          : [
              { path: HELLO, action: 'modify', content: HELLO_TEXT },
              { path: SECRET, action: 'modify', content: LEAKED },
            ];
      };
      const config = makeConfig(BASE_CONFIG);
      let implementer: Implementer;
      if (name === 'api') {
        vi.stubGlobal(
          'fetch',
          vi.fn(withLocalCatalog(['qwen2.5-coder:7b'], () => bundleResponse(attemptFiles()))),
        );
        implementer = createApiImplementer(config);
      } else {
        const write = async ({ projectDir }: ImplementerOptions) => {
          for (const file of attemptFiles()) {
            mkdirSync(join(projectDir, 'src'), { recursive: true });
            writeFileSync(join(projectDir, file.path), file.content);
          }
          return {
            success: true as const,
            output: 'ok',
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        };
        implementer = makeImplementer({
          capabilities: { writesFiles: 'direct' },
          implement: vi.fn().mockImplementation(write),
          retry: vi.fn().mockImplementation(write),
        });
      }
      const seen: string[] = [];
      const runValidation = vi.fn().mockImplementation(async ({ projectDir }) => {
        seen.push(read(projectDir, SECRET));
        return seen.length === 1
          ? [{ stage: 'test' as const, passed: false, error: 'hello is 0' }]
          : [];
      });

      const run = await runInWorkspace({ task: helloTask, config, implementer, runValidation });

      expect(run.onTieredApproval).toHaveBeenCalledTimes(1);
      expect(seen).toEqual([ORIGINAL, ORIGINAL]);
      expect(read(run.workspaceDir, HELLO)).toBe(HELLO_TEXT);
      expect(read(run.workspaceDir, EARLIER)).toBe(EARLIER_TEXT);
      expect(run.state.tasks[0]?.status).toBe('done');
    },
  );

  it('api: every file a bundle confirmed before the write is not asked again', {
    timeout: 60_000,
  }, async () => {
    const SECOND = '.env.test';
    vi.stubGlobal(
      'fetch',
      vi.fn(
        withLocalCatalog(['qwen2.5-coder:7b'], () =>
          bundleResponse([
            { path: SECRET, action: 'modify', content: LEAKED },
            { path: SECOND, action: 'create', content: LEAKED },
          ]),
        ),
      ),
    );
    const config = makeConfig(BASE_CONFIG);
    const task = makeTask({
      id: 'T001',
      action: 'modify',
      file: SECRET,
      files: [SECRET, SECOND],
      scope: { inBounds: [SECRET, SECOND] },
    });

    const run = await runInWorkspace({
      task,
      config,
      implementer: createApiImplementer(config),
      runValidation: vi.fn().mockResolvedValue([]),
      approve: true,
    });

    expect(run.onTieredApproval).toHaveBeenCalledTimes(2);
    expect(run.state.tasks[0]?.status).toBe('done');
  });

  it('staged copy: a mode-only change to a protected file is asked about', async () => {
    const CI_FILE = '.gitlab-ci.yml';
    const { projectDir, sessionId } = setupTaskProject({ [CI_FILE]: 'stages: []\n' });
    const config = makeConfig(BASE_CONFIG);
    const isolation = createRunIsolation({
      projectDir,
      sessionId,
      strategy: 'staged-copy',
      onFallback: () => {},
      onRetained: () => {},
    });
    disposers.push(() => isolation.dispose());
    const workspace = await isolation.acquire({ role: 'implementer', config });
    chmodSync(join(workspace.projectDir, CI_FILE), 0o755);
    const onTieredApproval = vi.fn().mockResolvedValue({ decision: 'deny', reason: 'no' });
    const task = makeTask({ id: 'T001', action: 'modify', file: CI_FILE });

    const gate = await gateAttemptChanges({
      wctx: makeTaskWorkflowContext({
        projectDir,
        sessionId,
        workspaceDir: workspace.projectDir,
        callbacks: makeCallbacks({ onTieredApproval }).callbacks,
        config,
        isolation,
      }),
      task,
      phase: 'implementing',
      workspace,
      preApprovedFiles: [],
      dependsOnFiles: [],
      onApproved: vi.fn(),
    });

    expect(onTieredApproval).toHaveBeenCalledWith(
      expect.objectContaining({ actionDescription: `write ${CI_FILE}` }),
    );
    expect(gate.outcome).toBe('denied');
  });

  it('an unsuccessful attempt that cannot be discarded blocks the next attempt', async () => {
    const { projectDir, sessionId } = setupTaskProject({ [HELLO]: HELLO_TEXT });
    const config = makeConfig(BASE_CONFIG);
    const isolation = createRunIsolation({
      projectDir,
      sessionId,
      strategy: 'staged-copy',
      onFallback: () => {},
      onRetained: () => {},
    });
    disposers.push(() => isolation.dispose());
    const failed = await isolation.acquire({ role: 'implementer', config });
    writeFileSync(join(failed.projectDir, HELLO), 'export const hello = "failed";\n');
    rmSync(join(dirname(failed.projectDir), 'attempt-base'), { recursive: true, force: true });

    failed.cleanup();

    await expect(isolation.acquire({ role: 'implementer', config })).rejects.toMatchObject({
      kind: 'isolation-cleanup-failed',
    });
  });

  it('a denied file that cannot be restored discards the attempt and stops before validation', async () => {
    const { projectDir, sessionId } = setupTaskProject({ [SECRET]: ORIGINAL });
    const snapshot = await getChangedFilesSnapshot(projectDir);
    writeFileSync(join(projectDir, SECRET), LEAKED);
    const failure = new Error('restore failed');
    const cleanup = vi.fn();
    const onTieredApproval = vi.fn().mockResolvedValue({ decision: 'deny', reason: 'no' });

    await expect(
      gateAttemptChanges({
        wctx: makeTaskWorkflowContext({
          projectDir,
          sessionId,
          callbacks: makeCallbacks({ onTieredApproval }).callbacks,
          config: makeConfig(BASE_CONFIG),
        }),
        task: makeTask({ id: 'T001', action: 'modify', file: SECRET }),
        phase: 'implementing',
        workspace: {
          projectDir,
          sandboxEnv: {},
          snapshot,
          targetBaseline: undefined,
          changedFiles: () => getChangedFilesSinceSnapshot(projectDir, snapshot),
          cleanup,
          revert: () => Promise.reject(failure),
        },
        preApprovedFiles: [],
        dependsOnFiles: [],
        onApproved: vi.fn(),
      }),
    ).rejects.toBe(failure);
    expect(cleanup).toHaveBeenCalledWith();
  });

  it('neither asks about nor attributes checkout edits when the attempt changed nothing', async () => {
    const { projectDir, sessionId } = setupTaskProject({ [SECRET]: ORIGINAL, [HELLO]: HELLO_TEXT });
    const config = makeConfig(BASE_CONFIG);
    const isolation = createRunIsolation({
      projectDir,
      sessionId,
      strategy: 'worktree',
      onFallback: () => {},
      onRetained: () => {},
    });
    disposers.push(() => isolation.dispose());
    const workspace = await isolation.acquire({ role: 'implementer', config });
    writeFileSync(join(projectDir, SECRET), LEAKED);
    writeFileSync(join(projectDir, HELLO), 'export const hello = "operator";\n');
    const onTieredApproval = vi.fn();
    const onApproved = vi.fn();

    const gate = await gateAttemptChanges({
      wctx: makeTaskWorkflowContext({
        projectDir,
        sessionId,
        workspaceDir: workspace.projectDir,
        isolation,
        config,
        callbacks: makeCallbacks({ onTieredApproval }).callbacks,
      }),
      task: helloTask,
      phase: 'implementing',
      workspace,
      preApprovedFiles: [],
      dependsOnFiles: [],
      onApproved,
    });

    expect(gate).toEqual({ outcome: 'allow', approvedFiles: [] });
    expect(onTieredApproval).not.toHaveBeenCalled();
    expect(onApproved).not.toHaveBeenCalled();
    expect(readFileSync(join(projectDir, SECRET), 'utf8')).toBe(LEAKED);
  });
});
