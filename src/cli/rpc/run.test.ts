import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { PassThrough, Writable } from 'node:stream';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createInitialState } from '../../core/state/machine.js';
import { saveState } from '../../core/state/persistence.js';
import { ensureSessionDir } from '../../core/paths-io.js';
import { CONFIG_FILE, DIPTYCH_DIR } from '../../core/paths.js';
import type { RunWorkflowOptions } from '../../engine/orchestrator/run/init.js';
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
      (line) => line.type === 'error' && String(line.error).includes('Invalid JSON'),
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
        typeof line.data.state === 'object' &&
        line.data.state !== null &&
        'feature' in line.data.state &&
        line.data.state.feature === 'status feature',
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
        message: 'Task failed',
        details: ['Something went wrong'],
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

    input.write('{"type":"recovery","action":"abort-workflow"}\n');
    await run;

    expect(parseLines(chunks)).toContainEqual(
      expect.objectContaining({ type: 'ack', command: 'recovery' }),
    );
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
        return 2;
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
        'messages' in line.data &&
        Array.isArray(line.data.messages) &&
        line.data.messages.length > 0 &&
        line.data.messages.some(
          (message) =>
            typeof message === 'string' && /clear/i.test(message) && message.includes('2'),
        ),
    );

    expect(clearCalls).toBe(1);

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
        line.error.includes('Invalid mode'),
    );

    finishWorkflow?.();
    await run;

    expect(parseLines(chunks)).not.toContainEqual(
      expect.objectContaining({ type: 'ack', command: 'slash' }),
    );
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
        line.error.includes('Unknown command') &&
        line.error.includes('Did you mean /mode?'),
    );

    finishWorkflow?.();
    await run;

    expect(parseLines(chunks)).not.toContainEqual(
      expect.objectContaining({ type: 'ack', command: 'slash' }),
    );
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
