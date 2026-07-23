import { describe, it, expect, afterEach } from 'vitest';
import { createConnection, type Socket } from 'node:net';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeRecoveryIssue } from '#testing/helpers/factories/recovery.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { ensureSessionDir } from '../../../src/core/paths-io.js';
import { saveState, loadState } from '../../../src/core/state/persistence.js';
import { taskId } from '../../../src/core/schemas/task.js';
import { createEventBus } from '../../../src/engine/events/bus.js';
import { startIpcServer, type IpcServer } from '../../../src/engine/ipc/server.js';
import { createIpcWorkflowBridge } from '../../../src/engine/ipc/workflow-bridge.js';
import type { RunWorkflowOptions } from '../../../src/engine/orchestrator/run/init.js';
import type { Summary } from '../../../src/core/schemas/summary.js';
import type { WorkflowState } from '../../../src/core/schemas/workflow.js';
import type { ServerMessage } from '../../../src/engine/ipc/protocol.js';
import { runWorkflowLoop } from '../../../src/engine/ipc/workflow-loop/run.js';

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
    tokenUsage: {
      plannerInput: 0,
      plannerOutput: 0,
      implementerInput: 0,
      implementerOutput: 0,
      escalationInput: 0,
      escalationOutput: 0,
    },
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

describe('runWorkflowLoop detached retry', () => {
  it('retry re-runs only failed work from the freshly saved state, not boot-time undefined', async () => {
    const projectDir = createTempDir('wl');
    tmpDirs.push(projectDir);
    ensureSessionDir(projectDir, SESSION_ID);

    const sessionDir = `${projectDir}/.diptych/sessions/${SESSION_ID}`;
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
    const observedSavedStates: Array<WorkflowState | undefined> = [];
    let call = 0;
    const fakeRunWorkflow = async (opts: RunWorkflowOptions): Promise<Summary> => {
      call += 1;
      observedSavedStates.push(opts.savedState);
      if (call === 1) {
        saveState(ref, failedPersistedState());
        return failedRunSummary();
      }
      return cleanRunSummary();
    };

    const summary = await runWorkflowLoop(
      { projectDir, sessionId: SESSION_ID, feature: 'detached retry' },
      srv,
      ipcBridge,
      bus,
      makeConfig(),
      fakeRunWorkflow,
    );

    ipcBridge.close();

    expect(call).toBe(2);
    expect(observedSavedStates[0]).toBeUndefined();
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

    const sessionDir = `${projectDir}/.diptych/sessions/${SESSION_ID}`;
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
    saveState(
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
      { projectDir, sessionId: SESSION_ID, feature: 'paused recovery' },
      srv,
      ipcBridge,
      bus,
      makeConfig(),
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

    const sessionDir = `${projectDir}/.diptych/sessions/${SESSION_ID}`;
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
      { projectDir, sessionId: SESSION_ID, feature: 'detached run' },
      srv,
      ipcBridge,
      bus,
      makeConfig(),
      fakeRunWorkflow,
    );

    ipcBridge.close();

    expect(observedHeadless).toEqual([undefined]);
  });

  it('abort at the failure prompt returns the failed summary without re-running', async () => {
    const projectDir = createTempDir('wl');
    tmpDirs.push(projectDir);
    ensureSessionDir(projectDir, SESSION_ID);

    const sessionDir = `${projectDir}/.diptych/sessions/${SESSION_ID}`;
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
      { projectDir, sessionId: SESSION_ID, feature: 'detached retry' },
      srv,
      ipcBridge,
      bus,
      makeConfig(),
      fakeRunWorkflow,
    );

    ipcBridge.close();

    expect(call).toBe(1);
    expect(summary.failed).toBe(1);
  });
});
