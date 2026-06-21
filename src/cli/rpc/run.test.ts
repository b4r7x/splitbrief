import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { PassThrough, Writable } from 'node:stream';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createInitialState } from '../../core/state/machine.js';
import { loadState, saveState } from '../../core/state/persistence.js';
import type { WorkflowState } from '../../core/schemas/workflow.js';
import { ensureSessionDir } from '../../core/paths-io.js';
import { CONFIG_FILE, DIPTYCH_DIR } from '../../core/paths.js';
import { loadConfig } from '../../core/config/load/io.js';
import type { RunWorkflowOptions } from '../../engine/orchestrator/run/init.js';
import { WORKFLOW_REWIND_ABORT_REASON } from '../../engine/orchestrator/run/workflow.js';
import { runRpc, rpcShutdownError } from './run.js';

let dirs: string[] = [];

function writeConfig(projectDir: string): void {
  const diptychDir = join(projectDir, DIPTYCH_DIR);
  mkdirSync(diptychDir, { recursive: true });
  const configPath = join(diptychDir, CONFIG_FILE);
  writeFileSync(
    configPath,
    [
      'version: 3',
      'planner:',
      '  kind: cli',
      '  tool: claude-code',
      'implementer:',
      '  kind: api',
      '  provider: ollama',
      '  api_base: http://localhost:11434/v1',
      '  model: qwen2.5-coder:7b',
      '  context_length: 32768',
      'validation:',
      '  typecheck: false',
      '  lint: false',
      '  test: false',
      '  test_command: "noop"',
      'workflow:',
      '  approve: default',
      '  max_retries: 3',
      '  commit_strategy: none',
      '  mode: standard',
      '  persist_transcript: false',
    ].join('\n'),
  );
  chmodSync(configPath, 0o600);
}

function setupProject(): string {
  const projectDir = createTempDir('rpc-run-test');
  dirs.push(projectDir);
  writeConfig(projectDir);
  return projectDir;
}

function makeStateWithMixedQueue(feature: string): WorkflowState {
  const queuedAt = '2026-01-01T00:00:00.000Z';
  return {
    ...createInitialState(feature),
    phase: 'planning',
    messageQueue: [
      {
        id: 'msg-pending',
        text: 'still pending',
        queuedAt,
        phase: 'planning',
        deliveredViaNative: false,
        nativeDeliveryState: 'pending',
      },
      {
        id: 'msg-native',
        text: 'already delivered natively',
        queuedAt,
        phase: 'planning',
        deliveredViaNative: true,
        nativeDeliveryState: 'delivered',
      },
      {
        id: 'msg-drained',
        text: 'already drained',
        queuedAt,
        phase: 'planning',
        deliveredViaNative: false,
        nativeDeliveryState: 'pending',
        drainedAt: '2026-01-01T00:00:01.000Z',
      },
    ],
  };
}

function captureWritable(): { chunks: string[]; output: Writable } {
  const chunks: string[] = [];
  const output = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  return { chunks, output };
}

function parseLines(
  chunks: string[],
): Array<{ type?: string; data?: unknown; command?: string; error?: string }> {
  return chunks
    .join('')
    .split('\n')
    .filter(Boolean)
    .map(
      (line) =>
        JSON.parse(line) as { type?: string; data?: unknown; command?: string; error?: string },
    );
}

async function waitForLine(
  chunks: string[],
  predicate: (line: { type?: string; data?: unknown; command?: string; error?: string }) => boolean,
): Promise<void> {
  await vi.waitFor(() => {
    expect(parseLines(chunks).some(predicate)).toBe(true);
  });
}

describe('rpcShutdownError', () => {
  it('tags the shutdown reason with a domain kind', () => {
    const err = rpcShutdownError.shuttingDown('stdin closed unexpectedly');
    expect(err.kind).toBe('rpc-shutting-down');
    expect(err.message).toBe('stdin closed unexpectedly');
    expect(err.data).toEqual({ reason: 'stdin closed unexpectedly' });
  });
});

describe('runRpc', () => {
  afterEach(() => {
    for (const dir of dirs) cleanupTempDir(dir);
    dirs = [];
  });

  it('wraps workflow events and waits for approve commands at approval gates', async () => {
    const projectDir = setupProject();
    const input = new PassThrough();
    const { chunks, output } = captureWritable();
    let approved: boolean | undefined;
    const runWorkflowStub = async (workflowOpts: RunWorkflowOptions) => {
      workflowOpts.eventBus?.publish({
        type: 'workflow_started',
        ts: 1,
        phase: 'researching',
        feature: 'ship rpc',
      });
      const result = await workflowOpts.callbacks.onApprovalNeeded(
        'spec',
        join(projectDir, 'spec.md'),
      );
      approved = result.approved;
      workflowOpts.eventBus?.publish({ type: 'plan_approved', ts: 2, phase: 'planning' });
    };

    const run = runRpc({
      feature: 'ship rpc',
      projectDir: projectDir,
      opts: { rpc: true },
      sessionId: 'rpc-session',
      deps: { input, output, runWorkflow: runWorkflowStub },
    });

    await waitForLine(
      chunks,
      (line) =>
        line.type === 'status' &&
        typeof line.data === 'object' &&
        line.data !== null &&
        'pending' in line.data &&
        line.data.pending === 'approval',
    );
    expect(approved).toBeUndefined();

    input.write('{"type":"approve"}\n');
    await run;

    const lines = parseLines(chunks);
    expect(lines).toContainEqual(
      expect.objectContaining({
        type: 'event',
        data: expect.objectContaining({ type: 'workflow_started' }),
      }),
    );
    expect(lines).toContainEqual({ type: 'ack', command: 'approve' });
    expect(lines).toContainEqual(
      expect.objectContaining({
        type: 'event',
        data: expect.objectContaining({ type: 'plan_approved' }),
      }),
    );
    expect(approved).toBe(true);
  });

  it('answers status commands with the persisted workflow state', async () => {
    const projectDir = setupProject();
    const sessionId = 'rpc-status-session';
    ensureSessionDir(projectDir, sessionId);
    saveState(
      { projectDir, sessionId },
      {
        ...createInitialState('status feature'),
        phase: 'planning',
      },
    );
    const input = new PassThrough();
    const { chunks, output } = captureWritable();
    let finishWorkflow: (() => void) | undefined;
    const workflowDone = new Promise<void>((resolve) => {
      finishWorkflow = resolve;
    });
    const runWorkflowStub = async () => workflowDone;

    const run = runRpc({
      feature: 'status feature',
      projectDir: projectDir,
      opts: { rpc: true },
      sessionId: sessionId,
      deps: { input, output, runWorkflow: runWorkflowStub },
    });

    input.write('not json\n');
    input.write('{"type":"status"}\n');
    await waitForLine(
      chunks,
      (line) => line.type === 'error' && line.error === 'Invalid RPC frame.',
    );
    await waitForLine(
      chunks,
      (line) =>
        line.type === 'status' &&
        typeof line.data === 'object' &&
        line.data !== null &&
        'sessionId' in line.data &&
        line.data.sessionId === sessionId &&
        'state' in line.data &&
        line.data.state === null &&
        'phase' in line.data &&
        line.data.phase === 'planning',
    );

    finishWorkflow?.();
    await run;
    expect(JSON.stringify(parseLines(chunks))).not.toContain('not json');
  });

  it('reports only undrained messages that were not delivered natively as queued', async () => {
    const projectDir = setupProject();
    const sessionId = 'rpc-status-queue-session';
    ensureSessionDir(projectDir, sessionId);
    saveState({ projectDir, sessionId }, makeStateWithMixedQueue('status queue feature'));
    const input = new PassThrough();
    const { chunks, output } = captureWritable();
    let finishWorkflow: (() => void) | undefined;
    const workflowDone = new Promise<void>((resolve) => {
      finishWorkflow = resolve;
    });
    const runWorkflowStub = async () => workflowDone;

    const run = runRpc({
      feature: 'status queue feature',
      projectDir: projectDir,
      opts: { rpc: true },
      sessionId: sessionId,
      deps: { input, output, runWorkflow: runWorkflowStub },
    });

    input.write('{"type":"status"}\n');
    await waitForLine(
      chunks,
      (line) =>
        line.type === 'status' &&
        typeof line.data === 'object' &&
        line.data !== null &&
        'queueDepth' in line.data &&
        line.data.queueDepth === 1,
    );

    finishWorkflow?.();
    await run;
  });

  it('uses the same pending queue depth for /queue show', async () => {
    const projectDir = setupProject();
    const sessionId = 'rpc-slash-queue-session';
    ensureSessionDir(projectDir, sessionId);
    saveState({ projectDir, sessionId }, makeStateWithMixedQueue('slash queue feature'));
    const input = new PassThrough();
    const { chunks, output } = captureWritable();
    let finishWorkflow: (() => void) | undefined;
    const workflowDone = new Promise<void>((resolve) => {
      finishWorkflow = resolve;
    });
    const runWorkflowStub = async () => workflowDone;

    const run = runRpc({
      feature: 'slash queue feature',
      projectDir: projectDir,
      opts: { rpc: true },
      sessionId: sessionId,
      deps: { input, output, runWorkflow: runWorkflowStub },
    });

    input.write('{"type":"slash","command":"/queue show"}\n');
    await waitForLine(
      chunks,
      (line) =>
        line.type === 'ack' &&
        line.command === 'slash' &&
        typeof line.data === 'object' &&
        line.data !== null &&
        'command' in line.data &&
        line.data.command === '/queue' &&
        'messages' in line.data &&
        Array.isArray(line.data.messages) &&
        line.data.messages.includes('[transcript omitted]'),
    );

    finishWorkflow?.();
    await run;
  });

  it('resolves the approval gate with approved:false on regenerate', async () => {
    const projectDir = setupProject();
    const input = new PassThrough();
    const { chunks, output } = captureWritable();
    let approved: boolean | undefined;
    let comment: string | undefined;
    const runWorkflowStub = async (workflowOpts: RunWorkflowOptions) => {
      const result = await workflowOpts.callbacks.onApprovalNeeded(
        'spec',
        join(projectDir, 'spec.md'),
      );
      approved = result.approved;
      comment = result.comment;
    };

    const run = runRpc({
      feature: 'regenerate test',
      projectDir: projectDir,
      opts: { rpc: true },
      sessionId: 'rpc-regenerate-session',
      deps: { input, output, runWorkflow: runWorkflowStub },
    });

    await waitForLine(
      chunks,
      (line) =>
        line.type === 'status' &&
        typeof line.data === 'object' &&
        line.data !== null &&
        'pending' in line.data &&
        line.data.pending === 'approval',
    );
    expect(approved).toBeUndefined();

    input.write('{"type":"regenerate","comment":"needs work"}\n');
    await run;

    expect(approved).toBe(false);
    expect(comment).toBe('needs work');
    expect(parseLines(chunks)).toContainEqual({ type: 'ack', command: 'regenerate' });
  });

  it('signals abort to the workflow on abort command', async () => {
    const projectDir = setupProject();
    const input = new PassThrough();
    const { chunks, output } = captureWritable();
    let abortSignal: AbortSignal | undefined;
    let finishWorkflow: (() => void) | undefined;
    const workflowDone = new Promise<void>((resolve) => {
      finishWorkflow = resolve;
    });
    const runWorkflowStub = async (workflowOpts: RunWorkflowOptions) => {
      abortSignal = workflowOpts.signal;
      await workflowDone;
    };

    const run = runRpc({
      feature: 'abort test',
      projectDir: projectDir,
      opts: { rpc: true },
      sessionId: 'rpc-abort-session',
      deps: { input, output, runWorkflow: runWorkflowStub },
    });

    await vi.waitFor(() => {
      expect(abortSignal).toBeDefined();
    });
    expect(abortSignal?.aborted).toBe(false);

    input.write('{"type":"abort"}\n');
    await waitForLine(chunks, (line) => line.type === 'ack' && line.command === 'abort');
    expect(abortSignal?.aborted).toBe(true);

    finishWorkflow?.();
    await run;
  });

  it('resumes applying recovery without re-prompting when selectedAction is set', async () => {
    const projectDir = setupProject();
    const sessionId = 'rpc-applying-session';
    ensureSessionDir(projectDir, sessionId);
    const stateWithApplyingRecovery = {
      ...createInitialState('applying recovery'),
      phase: 'implementing' as const,
      pendingRecovery: {
        id: 'rec-applying',
        reason: 'implementation-error' as const,
        phase: 'implementing' as const,
        status: 'applying' as const,
        message: 'Task failed',
        details: ['Retry in progress'],
        files: [],
        affectedTaskIds: [],
        availableActions: ['retry-same-worker' as const, 'abort-workflow' as const],
        recommendedAction: 'retry-same-worker' as const,
        selectedAction: 'abort-workflow' as const,
        createdAt: new Date().toISOString(),
      },
    };
    saveState({ projectDir, sessionId }, stateWithApplyingRecovery);

    const input = new PassThrough();
    const { chunks, output } = captureWritable();
    const runWorkflowStub = async () => {};

    await runRpc({
      feature: 'applying recovery',
      projectDir,
      opts: { rpc: true },
      savedState: stateWithApplyingRecovery,
      sessionId,
      deps: { input, output, runWorkflow: runWorkflowStub },
    });

    const lines = parseLines(chunks);
    expect(
      lines.some(
        (line) =>
          line.type === 'status' &&
          typeof line.data === 'object' &&
          line.data !== null &&
          'pending' in line.data &&
          (line.data as { pending?: string }).pending === 'recovery',
      ),
    ).toBe(false);
    expect(lines).toContainEqual(
      expect.objectContaining({
        type: 'ack',
        command: 'recovery',
        data: expect.objectContaining({ action: 'abort-workflow' }),
      }),
    );
  });

  it('dispatches recovery actions to the recovery gate', async () => {
    const projectDir = setupProject();
    const sessionId = 'rpc-recovery-session';
    ensureSessionDir(projectDir, sessionId);
    const stateWithRecovery = {
      ...createInitialState('recovery feature'),
      phase: 'implementing' as const,
      pendingRecovery: {
        id: 'rec-1',
        reason: 'implementation-error' as const,
        phase: 'implementing' as const,
        status: 'awaiting-user' as const,
        taskTitle: 'rpc-run-recovery-title-secret-54017',
        message: 'rpc-run-recovery-message-secret-54017',
        details: ['rpc-run-recovery-detail-secret-54017'],
        files: [],
        affectedTaskIds: [],
        availableActions: [
          'abort-workflow' as const,
          'retry-same-worker' as const,
          'skip-current-task' as const,
        ],
        recommendedAction: 'abort-workflow' as const,
        createdAt: new Date().toISOString(),
      },
    };
    saveState({ projectDir, sessionId }, stateWithRecovery);

    const input = new PassThrough();
    const { chunks, output } = captureWritable();

    const runWorkflowStub = async () => {};

    const run = runRpc({
      feature: 'recovery feature',
      projectDir: projectDir,
      opts: { rpc: true },
      savedState: stateWithRecovery,
      sessionId: sessionId,
      deps: { input, output, runWorkflow: runWorkflowStub },
    });

    await waitForLine(
      chunks,
      (line) =>
        line.type === 'status' &&
        typeof line.data === 'object' &&
        line.data !== null &&
        'pending' in line.data &&
        line.data.pending === 'recovery',
    );
    const statusLines = parseLines(chunks);
    expect(statusLines).toContainEqual(
      expect.objectContaining({
        type: 'status',
        data: expect.objectContaining({
          pending: 'recovery',
          issue: expect.objectContaining({
            id: 'rec-1',
            reason: 'implementation-error',
            taskTitle: '[transcript omitted]',
            message: '[transcript omitted]',
            details: ['[transcript omitted]'],
            availableActions: ['abort-workflow', 'retry-same-worker', 'skip-current-task'],
            recommendedAction: 'abort-workflow',
          }),
        }),
      }),
    );
    expect(JSON.stringify(statusLines)).not.toContain('rpc-run-recovery-title-secret-54017');
    expect(JSON.stringify(statusLines)).not.toContain('rpc-run-recovery-message-secret-54017');
    expect(JSON.stringify(statusLines)).not.toContain('rpc-run-recovery-detail-secret-54017');

    input.write('{"type":"recovery","action":"abort-workflow"}\n');
    await run;

    expect(parseLines(chunks)).toContainEqual(
      expect.objectContaining({ type: 'ack', command: 'recovery' }),
    );
  });

  it('does not acknowledge recovery commands when no recovery prompt is pending', async () => {
    const projectDir = setupProject();
    const input = new PassThrough();
    const { chunks, output } = captureWritable();
    let finishWorkflow: (() => void) | undefined;
    const workflowDone = new Promise<void>((resolve) => {
      finishWorkflow = resolve;
    });
    const runWorkflowStub = async () => workflowDone;

    const run = runRpc({
      feature: 'no recovery prompt',
      projectDir,
      opts: { rpc: true },
      sessionId: 'rpc-no-recovery-session',
      deps: { input, output, runWorkflow: runWorkflowStub },
    });

    input.write('{"type":"recovery","action":"abort-workflow"}\n');
    await waitForLine(
      chunks,
      (line) =>
        line.type === 'error' &&
        typeof line.error === 'string' &&
        line.error === 'Recovery command rejected.',
    );

    finishWorkflow?.();
    await run;

    expect(parseLines(chunks)).not.toContainEqual(
      expect.objectContaining({ type: 'ack', command: 'recovery' }),
    );
  });

  it('does not acknowledge invalid or unavailable recovery actions', async () => {
    const projectDir = setupProject();
    const sessionId = 'rpc-invalid-recovery-session';
    ensureSessionDir(projectDir, sessionId);
    const stateWithRecovery: WorkflowState = {
      ...createInitialState('invalid recovery feature'),
      phase: 'implementing',
      pendingRecovery: {
        id: 'rec-invalid',
        reason: 'retry-exhausted',
        phase: 'implementing',
        status: 'awaiting-user',
        message: 'Recovery required',
        details: [],
        files: [],
        affectedTaskIds: [],
        availableActions: ['retry-same-worker', 'abort-workflow'],
        recommendedAction: 'retry-same-worker',
        createdAt: new Date().toISOString(),
      },
    };
    saveState({ projectDir, sessionId }, stateWithRecovery);

    const input = new PassThrough();
    const { chunks, output } = captureWritable();
    const run = runRpc({
      feature: 'invalid recovery feature',
      projectDir,
      opts: { rpc: true },
      savedState: stateWithRecovery,
      sessionId,
      deps: { input, output, runWorkflow: async () => {} },
    });

    await waitForLine(
      chunks,
      (line) =>
        line.type === 'status' &&
        typeof line.data === 'object' &&
        line.data !== null &&
        'pending' in line.data &&
        line.data.pending === 'recovery',
    );

    input.write('{"type":"recovery","action":"not-real"}\n');
    await waitForLine(
      chunks,
      (line) =>
        line.type === 'error' &&
        typeof line.error === 'string' &&
        line.error === 'Recovery command rejected.',
    );
    input.write('{"type":"recovery","action":"continue"}\n');
    await waitForLine(
      chunks,
      (line) =>
        line.type === 'error' &&
        typeof line.error === 'string' &&
        line.error === 'Recovery command rejected.',
    );
    input.write('{"type":"recovery","action":"abort-workflow"}\n');
    await run;

    const lines = parseLines(chunks);
    expect(lines).not.toContainEqual(
      expect.objectContaining({
        type: 'ack',
        command: 'recovery',
        data: expect.objectContaining({ action: 'not-real' }),
      }),
    );
    expect(lines).not.toContainEqual(
      expect.objectContaining({
        type: 'ack',
        command: 'recovery',
        data: expect.objectContaining({ action: 'continue' }),
      }),
    );
    expect(lines).toContainEqual(
      expect.objectContaining({
        type: 'ack',
        command: 'recovery',
        data: expect.objectContaining({ action: 'abort-workflow' }),
      }),
    );
  });

  it('does not send a second queued recovery ACK after the prompt is resolved', async () => {
    const projectDir = setupProject();
    const sessionId = 'rpc-double-recovery-session';
    ensureSessionDir(projectDir, sessionId);
    const stateWithRecovery: WorkflowState = {
      ...createInitialState('double recovery feature'),
      phase: 'implementing',
      pendingRecovery: {
        id: 'rec-double',
        reason: 'retry-exhausted',
        phase: 'implementing',
        status: 'awaiting-user',
        message: 'Recovery required',
        details: [],
        files: [],
        affectedTaskIds: [],
        availableActions: ['abort-workflow'],
        recommendedAction: 'abort-workflow',
        createdAt: new Date().toISOString(),
      },
    };
    saveState({ projectDir, sessionId }, stateWithRecovery);

    const input = new PassThrough();
    const { chunks, output } = captureWritable();
    const run = runRpc({
      feature: 'double recovery feature',
      projectDir,
      opts: { rpc: true },
      savedState: stateWithRecovery,
      sessionId,
      deps: { input, output, runWorkflow: async () => {} },
    });

    await waitForLine(
      chunks,
      (line) =>
        line.type === 'status' &&
        typeof line.data === 'object' &&
        line.data !== null &&
        'pending' in line.data &&
        line.data.pending === 'recovery',
    );

    input.write(
      '{"type":"recovery","action":"abort-workflow"}\n{"type":"recovery","action":"abort-workflow"}\n',
    );
    await run;

    const queuedAcks = parseLines(chunks).filter(
      (line) =>
        line.type === 'ack' &&
        line.command === 'recovery' &&
        typeof line.data === 'object' &&
        line.data !== null &&
        'queued' in line.data &&
        line.data.queued === true,
    );
    expect(queuedAcks).toHaveLength(1);
  });

  it('executes slash commands without crashing', async () => {
    const projectDir = setupProject();
    const input = new PassThrough();
    const { chunks, output } = captureWritable();
    let finishWorkflow: (() => void) | undefined;
    const workflowDone = new Promise<void>((resolve) => {
      finishWorkflow = resolve;
    });
    const runWorkflowStub = async () => workflowDone;

    const run = runRpc({
      feature: 'slash test',
      projectDir: projectDir,
      opts: { rpc: true },
      sessionId: 'rpc-slash-session',
      deps: { input, output, runWorkflow: runWorkflowStub },
    });

    input.write('{"type":"slash","command":"/mode quick"}\n');
    await waitForLine(chunks, (line) => line.type === 'ack' && line.command === 'slash');

    finishWorkflow?.();
    await run;
  });

  it('keeps raw revise feedback transient while restarting the RPC workflow turn', async () => {
    const projectDir = setupProject();
    const sessionId = 'rpc-revise-session';
    const sentinel = 'rpc-raw-revise-secret-81427';
    const state: WorkflowState = {
      ...createInitialState('revise rpc feature'),
      phase: 'reviewing-plan',
    };
    ensureSessionDir(projectDir, sessionId);
    saveState({ projectDir, sessionId }, state);

    const input = new PassThrough();
    const { chunks, output } = captureWritable();
    const workflowCalls: RunWorkflowOptions[] = [];
    const runWorkflowStub = async (workflowOpts: RunWorkflowOptions) => {
      workflowCalls.push(workflowOpts);
      if (workflowCalls.length === 1) {
        await new Promise<void>((resolve) => {
          workflowOpts.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        expect(workflowOpts.signal?.reason).toBe(WORKFLOW_REWIND_ABORT_REASON);
        return;
      }
      saveState(
        { projectDir, sessionId },
        { ...createInitialState('revise rpc feature'), phase: 'implementing' },
      );
    };

    const run = runRpc({
      feature: 'revise rpc feature',
      projectDir,
      opts: { rpc: true },
      savedState: state,
      sessionId,
      deps: { input, output, runWorkflow: runWorkflowStub },
    });

    await vi.waitFor(() => {
      expect(workflowCalls).toHaveLength(1);
    });
    input.write(`{"type":"slash","command":"/revise-plan ${sentinel}"}\n`);
    await waitForLine(
      chunks,
      (line) =>
        line.type === 'ack' &&
        line.command === 'slash' &&
        typeof line.data === 'object' &&
        line.data !== null &&
        'command' in line.data &&
        line.data.command === '/revise-plan',
    );
    await run;

    expect(workflowCalls).toHaveLength(2);
    expect(workflowCalls[1]?.rewindFeedback).toBe(sentinel);
    expect(loadState({ projectDir, sessionId })?.rewindPending).toBeUndefined();
    const lines = parseLines(chunks);
    expect(lines).toContainEqual(
      expect.objectContaining({
        type: 'event',
        data: expect.objectContaining({
          type: 'rewind_to_plan',
          comment: '[transcript omitted]',
        }),
      }),
    );
    expect(JSON.stringify(lines)).not.toContain(sentinel);
    expect(JSON.stringify(lines)).not.toContain(`/revise-plan ${sentinel}`);
  });

  it('preserves rewind feedback when revising during a pending approval gate', async () => {
    const projectDir = setupProject();
    const sessionId = 'rpc-approval-revise-session';
    const sentinel = 'rpc-approval-revise-secret-42861';
    const state: WorkflowState = {
      ...createInitialState('approval revise rpc feature'),
      phase: 'reviewing-plan',
    };
    ensureSessionDir(projectDir, sessionId);
    saveState({ projectDir, sessionId }, state);

    const input = new PassThrough();
    const { chunks, output } = captureWritable();
    const workflowCalls: RunWorkflowOptions[] = [];
    let gateError: unknown;
    const runWorkflowStub = async (workflowOpts: RunWorkflowOptions) => {
      workflowCalls.push(workflowOpts);
      if (workflowCalls.length === 1) {
        try {
          await workflowOpts.callbacks.onApprovalNeeded('plan', join(projectDir, 'plan.md'));
        } catch (err) {
          gateError = err;
        }
        expect(workflowOpts.signal?.reason).toBe(WORKFLOW_REWIND_ABORT_REASON);
        return;
      }
      saveState(
        { projectDir, sessionId },
        { ...createInitialState('approval revise rpc feature'), phase: 'implementing' },
      );
    };

    const run = runRpc({
      feature: 'approval revise rpc feature',
      projectDir,
      opts: { rpc: true },
      savedState: state,
      sessionId,
      deps: { input, output, runWorkflow: runWorkflowStub },
    });

    await waitForLine(
      chunks,
      (line) =>
        line.type === 'status' &&
        typeof line.data === 'object' &&
        line.data !== null &&
        'pending' in line.data &&
        line.data.pending === 'approval',
    );
    input.write(`{"type":"slash","command":"/revise-plan ${sentinel}"}\n`);
    await waitForLine(
      chunks,
      (line) =>
        line.type === 'ack' &&
        line.command === 'slash' &&
        typeof line.data === 'object' &&
        line.data !== null &&
        'command' in line.data &&
        line.data.command === '/revise-plan',
    );
    await run;

    expect(gateError).toMatchObject({ kind: 'operation-aborted' });
    expect(workflowCalls).toHaveLength(2);
    expect(workflowCalls[1]?.rewindFeedback).toBe(sentinel);
    expect(loadState({ projectDir, sessionId })?.rewindPending).toBeUndefined();
    expect(JSON.stringify(parseLines(chunks))).not.toContain(sentinel);
  });

  it('restarts the workflow when revising during a pending recovery gate', async () => {
    const projectDir = setupProject();
    const sessionId = 'rpc-recovery-revise-session';
    const sentinel = 'rpc-recovery-revise-secret-39162';
    const stateWithRecovery: WorkflowState = {
      ...createInitialState('recovery revise rpc feature'),
      phase: 'implementing',
      pendingRecovery: {
        id: 'rec-revise',
        reason: 'implementation-error',
        phase: 'implementing',
        status: 'awaiting-user',
        message: 'Task failed',
        details: ['Retry or revise'],
        files: [],
        affectedTaskIds: [],
        availableActions: ['retry-same-worker', 'abort-workflow'],
        recommendedAction: 'retry-same-worker',
        createdAt: new Date().toISOString(),
      },
    };
    ensureSessionDir(projectDir, sessionId);
    saveState({ projectDir, sessionId }, stateWithRecovery);

    const input = new PassThrough();
    const { chunks, output } = captureWritable();
    const workflowCalls: RunWorkflowOptions[] = [];
    const runWorkflowStub = async (workflowOpts: RunWorkflowOptions) => {
      workflowCalls.push(workflowOpts);
      saveState(
        { projectDir, sessionId },
        { ...createInitialState('recovery revise rpc feature'), phase: 'implementing' },
      );
    };

    const run = runRpc({
      feature: 'recovery revise rpc feature',
      projectDir,
      opts: { rpc: true },
      savedState: stateWithRecovery,
      sessionId,
      deps: { input, output, runWorkflow: runWorkflowStub },
    });

    await waitForLine(
      chunks,
      (line) =>
        line.type === 'status' &&
        typeof line.data === 'object' &&
        line.data !== null &&
        'pending' in line.data &&
        line.data.pending === 'recovery',
    );
    input.write(`{"type":"slash","command":"/revise-plan ${sentinel}"}\n`);
    await waitForLine(
      chunks,
      (line) =>
        line.type === 'ack' &&
        line.command === 'slash' &&
        typeof line.data === 'object' &&
        line.data !== null &&
        'command' in line.data &&
        line.data.command === '/revise-plan',
    );
    await run;

    expect(workflowCalls).toHaveLength(1);
    expect(workflowCalls[0]?.rewindFeedback).toBe(sentinel);
    expect(loadState({ projectDir, sessionId })?.pendingRecovery).toBeUndefined();
    expect(loadState({ projectDir, sessionId })?.rewindPending).toBeUndefined();
    expect(JSON.stringify(parseLines(chunks))).not.toContain(sentinel);
  });

  it('clears the live workflow queue from slash commands', async () => {
    const projectDir = setupProject();
    const input = new PassThrough();
    const { chunks, output } = captureWritable();
    let finishWorkflow: (() => void) | undefined;
    let clearHandlerInstalled = false;
    let clearCalls = 0;
    const workflowDone = new Promise<void>((resolve) => {
      finishWorkflow = resolve;
    });
    const runWorkflowStub = async (workflowOpts: RunWorkflowOptions) => {
      workflowOpts.sinks.setClearQueueHandler?.(() => {
        clearCalls += 1;
        return { status: 'cleared', count: 2 };
      });
      clearHandlerInstalled = true;
      await workflowDone;
    };

    const run = runRpc({
      feature: 'queue clear test',
      projectDir: projectDir,
      opts: { rpc: true },
      sessionId: 'rpc-queue-clear-session',
      deps: { input, output, runWorkflow: runWorkflowStub },
    });

    await vi.waitFor(() => {
      expect(clearHandlerInstalled).toBe(true);
    });
    input.write('{"type":"slash","command":"/queue clear"}\n');
    await waitForLine(
      chunks,
      (line) =>
        line.type === 'ack' &&
        line.command === 'slash' &&
        typeof line.data === 'object' &&
        line.data !== null &&
        'command' in line.data &&
        line.data.command === '/queue' &&
        'messages' in line.data &&
        Array.isArray(line.data.messages) &&
        line.data.messages.includes('[transcript omitted]'),
    );

    expect(clearCalls).toBe(1);

    finishWorkflow?.();
    await run;
  });

  it('applies RPC /yolo to the active workflow approval state without persisting config', async () => {
    const projectDir = setupProject();
    const input = new PassThrough();
    const { chunks, output } = captureWritable();
    let finishWorkflow: (() => void) | undefined;
    const workflowDone = new Promise<void>((resolve) => {
      finishWorkflow = resolve;
    });
    let activeApprovalEnabled: (() => boolean) | undefined;
    const runWorkflowStub = async (workflowOpts: RunWorkflowOptions) => {
      activeApprovalEnabled = workflowOpts.getApprovalEnabled;
      await workflowDone;
    };

    const run = runRpc({
      feature: 'rpc yolo active state test',
      projectDir,
      opts: { rpc: true },
      sessionId: 'rpc-yolo-session',
      deps: { input, output, runWorkflow: runWorkflowStub },
    });

    await vi.waitFor(() => {
      expect(activeApprovalEnabled).toBeDefined();
      expect(activeApprovalEnabled?.()).toBe(true);
    });
    input.write('{"type":"slash","command":"/yolo"}\n');
    await waitForLine(
      chunks,
      (line) =>
        line.type === 'ack' &&
        line.command === 'slash' &&
        typeof line.data === 'object' &&
        line.data !== null &&
        'command' in line.data &&
        line.data.command === '/yolo',
    );

    expect(activeApprovalEnabled?.()).toBe(false);
    expect(loadConfig(projectDir).config.approval?.enabled).not.toBe(false);

    finishWorkflow?.();
    await run;
  });

  it('does not acknowledge slash commands that report errors', async () => {
    const projectDir = setupProject();
    const input = new PassThrough();
    const { chunks, output } = captureWritable();
    let finishWorkflow: (() => void) | undefined;
    const workflowDone = new Promise<void>((resolve) => {
      finishWorkflow = resolve;
    });
    const runWorkflowStub = async () => workflowDone;

    const run = runRpc({
      feature: 'slash error test',
      projectDir: projectDir,
      opts: { rpc: true },
      sessionId: 'rpc-slash-error-session',
      deps: { input, output, runWorkflow: runWorkflowStub },
    });

    input.write('{"type":"slash","command":"/mode nope"}\n');
    await waitForLine(
      chunks,
      (line) =>
        line.type === 'error' &&
        typeof line.error === 'string' &&
        line.error === 'Slash command failed.',
    );

    finishWorkflow?.();
    await run;

    expect(parseLines(chunks)).not.toContainEqual(
      expect.objectContaining({ type: 'ack', command: 'slash' }),
    );
    expect(JSON.stringify(parseLines(chunks))).not.toContain('/mode nope');
  });

  it('reports a typo without executing the nearest fuzzy slash command', async () => {
    const projectDir = setupProject();
    const input = new PassThrough();
    const { chunks, output } = captureWritable();
    let finishWorkflow: (() => void) | undefined;
    const workflowDone = new Promise<void>((resolve) => {
      finishWorkflow = resolve;
    });
    const runWorkflowStub = async () => workflowDone;

    const run = runRpc({
      feature: 'slash typo test',
      projectDir: projectDir,
      opts: { rpc: true },
      sessionId: 'rpc-slash-typo-session',
      deps: { input, output, runWorkflow: runWorkflowStub },
    });

    input.write('{"type":"slash","command":"/mde"}\n');
    await waitForLine(
      chunks,
      (line) =>
        line.type === 'error' &&
        typeof line.error === 'string' &&
        line.error === 'Slash command failed.',
    );

    finishWorkflow?.();
    await run;

    expect(parseLines(chunks)).not.toContainEqual(
      expect.objectContaining({ type: 'ack', command: 'slash' }),
    );
    expect(JSON.stringify(parseLines(chunks))).not.toContain('/mde');
  });

  it('shuts down cleanly when stdin closes', async () => {
    const projectDir = setupProject();
    const input = new PassThrough();
    const { chunks, output } = captureWritable();
    let finishWorkflow: (() => void) | undefined;
    const workflowDone = new Promise<void>((resolve) => {
      finishWorkflow = resolve;
    });
    const runWorkflowStub = async () => workflowDone;

    const run = runRpc({
      feature: 'eof test',
      projectDir: projectDir,
      opts: { rpc: true },
      sessionId: 'rpc-eof-session',
      deps: { input, output, runWorkflow: runWorkflowStub },
    });

    input.end();
    finishWorkflow?.();
    await run;

    const lines = parseLines(chunks);
    const hasError = lines.some(
      (line) => line.type === 'error' && String(line.error).includes('crash'),
    );
    expect(hasError).toBe(false);
  });

  it('rejects pending approval gate when stdin closes unexpectedly', async () => {
    const projectDir = setupProject();
    const input = new PassThrough();
    const { output } = captureWritable();
    const runWorkflowStub = async (workflowOpts: RunWorkflowOptions) => {
      await workflowOpts.callbacks.onApprovalNeeded('spec', join(projectDir, 'spec.md'));
    };

    const run = runRpc({
      feature: 'gate-close test',
      projectDir: projectDir,
      opts: { rpc: true },
      sessionId: 'rpc-gate-close-session',
      deps: { input, output, runWorkflow: runWorkflowStub },
    });

    await vi.waitFor(() => {
      expect(input.readable).toBe(true);
    });

    input.end();
    await expect(run).rejects.toThrow('stdin closed');
  });
});
