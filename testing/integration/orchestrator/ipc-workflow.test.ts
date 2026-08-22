import { describe, it, expect, afterEach } from 'vitest';
import { createConnection, type Socket } from 'node:net';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeRecoveryIssue } from '#testing/helpers/factories/recovery.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { ensureSessionDir } from '../../../src/core/paths-io.js';
import { loadState, saveState } from '../../../src/core/state/persistence.js';
import { acquireStateAuthority } from '../../../src/core/state/authority.js';
import { taskId } from '../../../src/core/schemas/task.js';
import { createEventBus } from '../../../src/engine/events/bus.js';
import { startIpcServer, type IpcServer } from '../../../src/engine/ipc/server.js';
import { createIpcWorkflowBridge } from '../../../src/engine/ipc/workflow-bridge.js';
import type { RunWorkflowOptions } from '../../../src/engine/orchestrator/run/init.js';
import type { Summary } from '../../../src/core/schemas/summary.js';
import type { WorkflowState } from '../../../src/core/schemas/workflow.js';
import type { StateAuthorityReceipt } from '../../../src/core/state/types.js';
import type { ServerMessage } from '../../../src/engine/ipc/protocol.js';
import { runWorkflowLoop } from '../../../src/engine/ipc/workflow-loop/run.js';
import { executableReceipt } from '#testing/helpers/custom-command-based.js';
import {
  parsePreparedConfig,
  type PreparedExecution,
} from '../../../src/engine/runners/prepared-execution.js';
import { makeUsage } from '#testing/helpers/factories/summary.js';

const AUTH_TOKEN = 'workflow-loop-token';
const SESSION_ID = 's';

const tmpDirs: string[] = [];
const sockets: Socket[] = [];
const servers: IpcServer[] = [];

afterEach(async () => {
  for (const s of sockets.splice(0)) {
    if (!s.destroyed) s.destroy();
  }
  for (const srv of servers.splice(0)) {
    await srv.close().catch(() => undefined);
  }
  for (const dir of tmpDirs.splice(0)) cleanupTempDir(dir);
});

function connectClient(sockPath: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(sockPath);
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });
}

async function attachRecoveryAnsweringClient(sockPath: string, action: string): Promise<Socket> {
  const socket = await connectClient(sockPath);
  sockets.push(socket);
  let buf = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    buf += chunk;
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const msg = JSON.parse(trimmed) as ServerMessage;
      if (msg.kind === 'prompt_request' && msg.request.kind === 'recovery_needed') {
        socket.write(
          JSON.stringify({
            kind: 'prompt_response',
            requestId: msg.request.requestId,
            response: { kind: 'recovery_needed', action },
          }) + '\n',
        );
      }
    }
  });
  await new Promise<void>((resolve, reject) => {
    const onReady = (chunk: string) => {
      if (chunk.includes('session_meta')) {
        socket.removeListener('data', onReady);
        resolve();
      }
    };
    socket.once('error', reject);
    socket.on('data', onReady);
    socket.write(JSON.stringify({ kind: 'authenticate', token: AUTH_TOKEN }) + '\n');
  });
  return socket;
}

function failedRunSummary(): Summary {
  return {
    feature: 'detached retry',
    totalTasks: 2,
    completedByLocal: 1,
    escalatedToPlanner: 0,
    skipped: 0,
    failed: 1,
    totalTime: 0,
    tokenUsage: makeUsage(),
    estimatedCostSavings: '$0.00',
    escalationRate: 0,
  };
}

function cleanRunSummary(): Summary {
  return { ...failedRunSummary(), completedByLocal: 2, failed: 0 };
}

function failedPersistedState(): WorkflowState {
  return makeImplState(
    [
      makeTask({ id: 'T001', status: 'done' }),
      makeTask({ id: 'T002', status: 'failed', file: 'src/two.ts' }),
    ],
    { currentTaskIndex: 1, phase: 'implementing' },
  );
}

function seedOwnerState(
  ref: { projectDir: string; sessionId: string },
  state: WorkflowState,
): StateAuthorityReceipt {
  saveState(ref, state);
  const acquired = acquireStateAuthority({
    ref,
    purpose: 'resume',
    ownerId: 'ipc-workflow-test-owner',
    runId: 'ipc-workflow-test-run',
    acquisitionId: `ipc-workflow-test-${ref.sessionId}`,
  });
  if (acquired.kind !== 'fenced') {
    throw new Error(`Expected a fenced owner, got ${acquired.kind}.`);
  }
  return acquired.receipt;
}

function preparedExecution(projectDir: string, feature: string): PreparedExecution {
  const config = parsePreparedConfig(makeConfig());
  const preparationId = `ipc-${SESSION_ID}-preparation`;
  const active = {
    version: 1 as const,
    sessionId: SESSION_ID,
    generation: 'aa111111-1111-4111-8111-111111111111',
  };
  return {
    purpose: 'new-workflow',
    config,
    preparationId,
    report: {
      generatedAt: '2026-08-04T00:00:00.000Z',
      projectDir,
      status: 'ready',
      counts: { ok: 2, info: 0, warning: 0, blocker: 0 },
      nextAction: { kind: 'continue', label: 'Continue', reason: 'Ready' },
      sections: [],
      metadata: {},
    },
    gates: [
      {
        kind: 'cli',
        slot: { role: 'planner' },
        preparationId,
        tool: 'claude-code',
        executable: executableReceipt(),
      },
      {
        kind: 'api',
        slot: { role: 'implementer', profile: 'default' },
        preparationId,
        provider: 'ollama',
        endpointOrigin: 'http://localhost:11434',
      },
    ],
    session: { kind: 'existing', ref: { projectDir, sessionId: SESSION_ID }, active },
    runtime: { feature, allowRepoRunners: false, allowHooks: false },
  };
}

describe('runWorkflowLoop detached retry', () => {
  it('retry re-runs only failed work from the authoritative state head', async () => {
    const projectDir = createTempDir('wl');
    tmpDirs.push(projectDir);
    ensureSessionDir(projectDir, SESSION_ID);

    const sessionDir = `${projectDir}/.splitbrief/sessions/${SESSION_ID}`;
    const bus = createEventBus();
    const ipcBridge = createIpcWorkflowBridge(bus);
    const srv = await startIpcServer({
      sessionId: SESSION_ID,
      sessionDir,
      startedAt: Date.now(),
      mode: 'standard',
      feature: 'detached retry',
      authToken: AUTH_TOKEN,
      bus,
      onUserInput: () => undefined,
    });
    servers.push(srv);

    await attachRecoveryAnsweringClient(srv.sockPath, 'retry-same-worker');

    const ref = { projectDir, sessionId: SESSION_ID };
    const authority = seedOwnerState(ref, failedPersistedState());
    const observedSavedStates: Array<WorkflowState | undefined> = [];
    let call = 0;
    const fakeRunWorkflow = async (opts: RunWorkflowOptions): Promise<Summary> => {
      call += 1;
      observedSavedStates.push(opts.savedState);
      if (call === 1) return failedRunSummary();
      return cleanRunSummary();
    };

    const prepared = preparedExecution(projectDir, 'detached retry');

    const summary = await runWorkflowLoop(
      { prepared, authority },
      srv,
      ipcBridge,
      bus,
      fakeRunWorkflow,
    );

    ipcBridge.close();

    expect(call).toBe(2);
    expect(observedSavedStates[0]?.tasks.map((task) => task.status)).toEqual(['done', 'failed']);
    const retryState = observedSavedStates[1];
    expect(retryState).toBeDefined();
    expect(retryState?.tasks.map((task) => task.status)).toEqual(['done', 'pending']);
    expect(retryState?.currentTaskIndex).toBe(1);
    expect(retryState?.phase).toBe('implementing');
    expect(retryState?.attempt).toBe(0);
    expect(retryState?.pendingRecovery).toBeUndefined();

    const persisted = loadState(ref);
    expect(persisted?.tasks.map((task) => task.status)).toEqual(['done', 'pending']);

    expect(summary.failed).toBe(0);
  });

  it('reopens paused pending recovery and applies the client action before running', async () => {
    const projectDir = createTempDir('wl');
    tmpDirs.push(projectDir);
    ensureSessionDir(projectDir, SESSION_ID);

    const sessionDir = `${projectDir}/.splitbrief/sessions/${SESSION_ID}`;
    const bus = createEventBus();
    const ipcBridge = createIpcWorkflowBridge(bus);
    const srv = await startIpcServer({
      sessionId: SESSION_ID,
      sessionDir,
      startedAt: Date.now(),
      mode: 'standard',
      feature: 'paused recovery',
      authToken: AUTH_TOKEN,
      bus,
      onUserInput: () => undefined,
    });
    servers.push(srv);

    const ref = { projectDir, sessionId: SESSION_ID };
    const authority = seedOwnerState(
      ref,
      makeImplState([makeTask({ id: 'T001', status: 'failed' })], {
        currentTaskIndex: 0,
        pendingRecovery: makeRecoveryIssue({
          status: 'paused',
          selectedAction: 'pause-run',
          taskId: taskId('T001'),
        }),
      }),
    );

    await attachRecoveryAnsweringClient(srv.sockPath, 'retry-same-worker');

    const observedSavedStates: Array<WorkflowState | undefined> = [];
    const fakeRunWorkflow = async (opts: RunWorkflowOptions): Promise<Summary> => {
      observedSavedStates.push(opts.savedState);
      return cleanRunSummary();
    };

    const summary = await runWorkflowLoop(
      { prepared: preparedExecution(projectDir, 'paused recovery'), authority },
      srv,
      ipcBridge,
      bus,
      fakeRunWorkflow,
    );

    ipcBridge.close();

    expect(observedSavedStates).toHaveLength(1);
    expect(observedSavedStates[0]?.pendingRecovery).toBeUndefined();
    expect(observedSavedStates[0]?.tasks[0]?.status).toBe('pending');
    expect(summary.failed).toBe(0);
  });

  it('does not request the stdout NDJSON sink — the detached server writes stdout to /dev/null', async () => {
    const projectDir = createTempDir('wl');
    tmpDirs.push(projectDir);
    ensureSessionDir(projectDir, SESSION_ID);

    const sessionDir = `${projectDir}/.splitbrief/sessions/${SESSION_ID}`;
    const bus = createEventBus();
    const ipcBridge = createIpcWorkflowBridge(bus);
    const srv = await startIpcServer({
      sessionId: SESSION_ID,
      sessionDir,
      startedAt: Date.now(),
      mode: 'standard',
      feature: 'detached run',
      authToken: AUTH_TOKEN,
      bus,
      onUserInput: () => undefined,
    });
    servers.push(srv);

    const observedHeadless: Array<boolean | undefined> = [];
    const fakeRunWorkflow = async (opts: RunWorkflowOptions): Promise<Summary> => {
      observedHeadless.push(opts.headless);
      return cleanRunSummary();
    };

    await runWorkflowLoop(
      { prepared: preparedExecution(projectDir, 'detached run') },
      srv,
      ipcBridge,
      bus,
      fakeRunWorkflow,
    );

    ipcBridge.close();

    expect(observedHeadless).toEqual([undefined]);
  });

  it('abort at the failure prompt returns the failed summary without re-running', async () => {
    const projectDir = createTempDir('wl');
    tmpDirs.push(projectDir);
    ensureSessionDir(projectDir, SESSION_ID);

    const sessionDir = `${projectDir}/.splitbrief/sessions/${SESSION_ID}`;
    const bus = createEventBus();
    const ipcBridge = createIpcWorkflowBridge(bus);
    const srv = await startIpcServer({
      sessionId: SESSION_ID,
      sessionDir,
      startedAt: Date.now(),
      mode: 'standard',
      feature: 'detached retry',
      authToken: AUTH_TOKEN,
      bus,
      onUserInput: () => undefined,
    });
    servers.push(srv);

    await attachRecoveryAnsweringClient(srv.sockPath, 'abort-workflow');

    const ref = { projectDir, sessionId: SESSION_ID };
    let call = 0;
    const fakeRunWorkflow = async (): Promise<Summary> => {
      call += 1;
      saveState(ref, failedPersistedState());
      return failedRunSummary();
    };

    const summary = await runWorkflowLoop(
      { prepared: preparedExecution(projectDir, 'detached retry') },
      srv,
      ipcBridge,
      bus,
      fakeRunWorkflow,
    );

    ipcBridge.close();

    expect(call).toBe(1);
    expect(summary.failed).toBe(1);
  });
});
