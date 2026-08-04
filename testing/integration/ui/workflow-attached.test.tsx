import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderFeature, flushEffects } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import type { Summary } from '../../../src/core/schemas/summary.js';
import type { RunWorkflowOptions } from '../../../src/engine/orchestrator/run/init.js';
import type { EngineEvent } from '../../../src/engine/events/types.js';
import type { IpcServer } from '../../../src/engine/ipc/server.js';
import { formatTasks } from '../../../src/engine/spec/formatter.js';
import { sessionDir } from '../../../src/core/paths.js';
import { WorkflowScreen } from '../../../src/app/screens/workflow.js';

const runWorkflow = vi.fn<(opts: RunWorkflowOptions) => Promise<Summary>>();
const workflowDeps = { runWorkflow };

const { createEventBus } = await import('../../../src/engine/events/bus.js');
const { startIpcServer } = await import('../../../src/engine/ipc/server.js');
const { configStore } = await import('../../../src/stores/project/config.js');
const { terminalSizeStore } = await import('../../../src/stores/ui/terminal-size.js');
const { routerStore } = await import('../../../src/stores/navigation/router.js');
const { eventsStore } = await import('../../../src/stores/workflow/events.js');

const ENTER = '\r';
const ATTACHED_WAIT_MS = 15_000;

function frameText(ui: { lastFrame: () => string | undefined }): string {
  return stripAnsiStyles(ui.lastFrame() ?? '');
}

async function waitForAttachedIpcReady(ui: { lastFrame: () => string | undefined }): Promise<void> {
  await vi.waitFor(() => {
    const frame = frameText(ui).toLowerCase();
    expect(frame).toContain('ctrl+d detach');
    expect(frame).not.toContain('connecting to server');
    expect(frame).not.toContain('reconnecting to server');
  }, ATTACHED_WAIT_MS);
  await flushEffects();
}

async function waitForAttachedApprovalPrompt(ui: {
  lastFrame: () => string | undefined;
}): Promise<void> {
  await vi.waitFor(() => {
    const frame = frameText(ui);
    expect(frame).toContain('approve');
    expect(frame.toLowerCase()).toContain('ctrl+e edit');
    expect(frame.toLowerCase()).not.toContain('queue a message to the running workflow');
  }, ATTACHED_WAIT_MS);
  await flushEffects();
}

const ipcServers: IpcServer[] = [];
const ipcTempDirs: string[] = [];

describe('WorkflowScreen attached client', () => {
  beforeEach(() => {
    resetAllStores();
    routerStore.init({ screen: 'home' });
    runWorkflow.mockReset();
    runWorkflow.mockReturnValue(new Promise<never>(() => {}));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    for (const server of ipcServers.splice(0)) {
      await server.close().catch(() => undefined);
    }
    for (const dir of ipcTempDirs.splice(0)) cleanupTempDir(dir);
    resetAllStores();
    routerStore.init({ screen: 'home' });
  });

  it('protects attached IPC events before storing them in workflow stores', async () => {
    const projectDir = createTempDir('workflow-screen-attached');
    ipcTempDirs.push(projectDir);
    const bus = createEventBus();
    const server = await startIpcServer({
      sessionId: 'attached-session',
      sessionDir: projectDir,
      startedAt: 1_000,
      mode: 'standard',
      feature: 'attached feature',
      authToken: 'token',
      bus,
      onUserInput: vi.fn(),
      persistTranscript: false,
    });
    ipcServers.push(server);
    let attached = false;
    const unsubscribeAttached = bus.subscribe((event) => {
      if (event.type === 'ipc_client_attached') attached = true;
    });
    const sentinel = 'attached-ipc-raw-secret-24561';
    configStore.__testReset({
      config: makeConfig({ workflow: { persistTranscript: false } }),
      projectDir,
    });
    terminalSizeStore.__testReset({ cols: 120, rows: 60, isSmall: false });
    routerStore.navigate({
      to: 'workflow',
      execution: {
        kind: 'attached',
        feature: 'attached feature',
        sessionId: 'attached-session',
        attach: { sockPath: server.sockPath, authToken: 'token' },
      },
    });

    const ui = renderFeature(
      <WorkflowScreen commands={[]} onRuntimeCommand={vi.fn()} deps={workflowDeps} />,
    );
    await vi.waitFor(() => {
      expect(attached).toBe(true);
    });
    unsubscribeAttached();

    bus.publish({
      type: 'runner_call_activity',
      ts: 1,
      phase: 'planning',
      callId: 'call-1',
      role: 'planner',
      backendKind: 'cli',
      sequence: 1,
      activityId: 'activity-1',
      stage: 'updated',
      kind: 'command',
      label: `running ${sentinel}`,
      target: `target ${sentinel}`,
      textPartial: `text ${sentinel}`,
      diagnosticPartial: `diagnostic ${sentinel}`,
      rawAvailable: true,
      expandId: `expand-${sentinel}`,
      redacted: false,
    });
    await vi.waitFor(() => {
      expect(eventsStore.get().events.some((event) => event.type === 'runner_call_activity')).toBe(
        true,
      );
    });

    const event = eventsStore
      .get()
      .events.find((entry): entry is Extract<EngineEvent, { type: 'runner_call_activity' }> => {
        return entry.type === 'runner_call_activity';
      });
    expect(event).toMatchObject({
      type: 'runner_call_activity',
      label: 'running command',
    });
    expect(event).not.toHaveProperty('rawAvailable');
    expect(event).not.toHaveProperty('target');
    expect(event).not.toHaveProperty('textPartial');
    expect(event).not.toHaveProperty('diagnosticPartial');
    expect(event).not.toHaveProperty('expandId');
    expect(JSON.stringify(eventsStore.get().events)).not.toContain(`target ${sentinel}`);
    expect(JSON.stringify(eventsStore.get().events)).not.toContain(`text ${sentinel}`);
    expect(JSON.stringify(eventsStore.get().events)).not.toContain(`diagnostic ${sentinel}`);
    expect(JSON.stringify(eventsStore.get().events)).not.toContain(`expand-${sentinel}`);
    expect(JSON.stringify(eventsStore.get().events)).not.toContain(sentinel);
    ui.unmount();
  });

  it('shows active approval commands instead of the queue hint while attached', async () => {
    const projectDir = createTempDir('workflow-screen-attached-prompt');
    ipcTempDirs.push(projectDir);
    const attachedSessionId = 'attached-prompt-session';
    const attachedSessionDir = sessionDir(projectDir, attachedSessionId);
    mkdirSync(attachedSessionDir, { recursive: true });
    writeFileSync(
      join(attachedSessionDir, 'tasks.md'),
      formatTasks([
        makeTask({
          id: 'T001',
          title: 'Attached prompt task',
          file: 'src/attached-prompt.ts',
          evidence: ['reviewable proof'],
          scope: { inBounds: ['src/attached-prompt.ts'], outOfBounds: [] },
        }),
      ]),
      'utf-8',
    );
    const bus = createEventBus();
    const serverDir = createTempDir('wsa');
    ipcTempDirs.push(serverDir);
    const server = await startIpcServer({
      sessionId: attachedSessionId,
      sessionDir: serverDir,
      startedAt: 1_000,
      mode: 'standard',
      feature: 'attached prompt feature',
      authToken: 'token',
      bus,
      onUserInput: vi.fn(),
      persistTranscript: false,
    });
    ipcServers.push(server);
    let attached = false;
    const unsubscribeAttached = bus.subscribe((event) => {
      if (event.type === 'ipc_client_attached') attached = true;
    });
    configStore.__testReset({
      config: makeConfig({ workflow: { persistTranscript: false } }),
      projectDir,
    });
    terminalSizeStore.__testReset({ cols: 120, rows: 60, isSmall: false });
    routerStore.navigate({
      to: 'workflow',
      execution: {
        kind: 'attached',
        feature: 'attached prompt feature',
        sessionId: attachedSessionId,
        attach: { sockPath: server.sockPath, authToken: 'token' },
      },
    });

    const ui = renderFeature(
      <WorkflowScreen commands={[]} onRuntimeCommand={vi.fn()} deps={workflowDeps} />,
    );
    await flushEffects();
    await vi.waitFor(() => {
      expect(attached).toBe(true);
    }, ATTACHED_WAIT_MS);
    await waitForAttachedIpcReady(ui);
    unsubscribeAttached();

    const response = server.requestClientPrompt({
      kind: 'approval_needed',
      approvalType: 'briefs',
      filePath: 'tasks.md',
    });

    await waitForAttachedApprovalPrompt(ui);

    await flushEffects();
    ui.stdin.write('reject');
    await flushEffects();
    ui.stdin.write(ENTER);
    await flushEffects();
    await expect(response).resolves.toEqual({
      kind: 'approval_needed',
      approved: false,
    });

    ui.unmount();
  });
});
