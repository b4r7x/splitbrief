import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { PassThrough, Writable } from 'node:stream';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { makeRecoveryIssue } from '#testing/helpers/factories/recovery.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { createInitialState } from '../../../../src/core/state/machine.js';
import {
  acquireStateAuthority,
  releaseStateAuthority,
} from '../../../../src/core/state/authority.js';
import type { StateAuthorityReceipt } from '../../../../src/core/state/types.js';
import { loadState, saveState } from '../../../../src/core/state/persistence.js';
import type { WorkflowState } from '../../../../src/core/schemas/workflow.js';
import type { BriefAdmissionInput } from '../../../../src/core/schemas/brief-recovery.js';
import {
  BriefReviewCommandSchema,
  type BriefReviewCommand,
} from '../../../../src/core/schemas/brief-review-command.js';
import { ensureSessionDir } from '../../../../src/core/paths-io.js';
import { CONFIG_FILE, SPLITBRIEF_DIR } from '../../../../src/core/paths.js';
import { taskId } from '../../../../src/core/schemas/task.js';
import { createBriefRecoveryState } from '../../../../src/engine/orchestrator/planning/brief-recovery.js';
import { projectBriefRecovery } from '../../../../src/engine/orchestrator/planning/brief-recovery-controller.js';
import { loadConfig } from '../../../../src/core/config/load/io.js';
import { configForSessionTranscriptPolicy } from '../../../../src/core/sessions/io.js';
import { reactivateExistingSession } from '../../../../src/core/sessions/active-pointer.js';
import type { EventBus } from '../../../../src/engine/events/types.js';
import type { RunWorkflowOptions } from '../../../../src/engine/orchestrator/run/init.js';
import {
  parsePreparedConfig,
  type PreparedExecution,
} from '../../../../src/engine/runners/prepared-execution.js';
import { WORKFLOW_REWIND_ABORT_REASON } from '../../../../src/engine/orchestrator/run/workflow.js';
import { runRpc } from '../../../../src/cli/rpc/run/host.js';
import { matches } from '../../../../src/utils/error.js';

const isRpcShuttingDown = matches('rpc-shutting-down');

let dirs: string[] = [];
const ownedAuthorities: Array<{
  ref: { projectDir: string; sessionId: string };
  receipt: StateAuthorityReceipt;
}> = [];

function saveOwnedState(
  ref: { projectDir: string; sessionId: string },
  state: WorkflowState,
): WorkflowState {
  ensureSessionDir(ref.projectDir, ref.sessionId);
  saveState(ref, state);
  const acquired = acquireStateAuthority({ ref, purpose: 'resume' });
  if (acquired.kind !== 'fenced') {
    throw new Error('RPC host fixture did not acquire a fenced state authority.');
  }
  ownedAuthorities.push({ ref, receipt: acquired.receipt });
  const loaded = loadState(ref);
  if (loaded === null) throw new Error('RPC host fixture state did not persist.');
  return loaded;
}

function briefReviewState(sessionId: string, feature: string): WorkflowState {
  const admission: BriefAdmissionInput = {
    sessionId,
    origin: { mode: 'standard', entry: 'initial' },
    continuation: { version: 1, kind: 'approval', mode: 'standard', entry: 'initial' },
    activeBrief: { revision: 1, hash: `brief-${sessionId}`, path: 'tasks.md' },
    report: {
      briefHash: `brief-${sessionId}`,
      report: { revision: 1, hash: `report-${sessionId}`, path: 'brief-quality.json' },
      ruleVersion: 'brief-quality-v1',
      issues: [],
      errorCount: 0,
    },
    qualityPolicyVersion: 'brief-quality-v1',
  };
  return {
    ...createInitialState(feature),
    phase: 'reviewing-briefs',
    briefRecovery: createBriefRecoveryState(admission, { epochId: `epoch-${sessionId}` }),
  };
}

function briefReviewCommand(
  ref: { projectDir: string; sessionId: string },
  action: 'status' | 'approve' | 'edit',
  operationId = `operation-${action}`,
  briefText = '# Edited Brief\n',
): BriefReviewCommand {
  const state = loadState(ref);
  if (state === null || state.briefRecovery === null || state.briefRecovery === undefined) {
    throw new Error('RPC host fixture has no Brief recovery state.');
  }
  const projection = projectBriefRecovery({
    sessionId: ref.sessionId,
    now: '2026-08-14T00:00:00.000Z',
    state: {
      stateVersion: state.stateVersion,
      stateRevision: state.stateRevision ?? 0,
      stateFence: state.stateFence ?? { token: 0, ownerId: 'rpc-host-fixture' },
      phase: state.phase,
      briefRecovery: state.briefRecovery,
    },
  });
  if (action === 'status') {
    return BriefReviewCommandSchema.parse({
      version: 1,
      sessionId: ref.sessionId,
      epochId: projection.epochId,
      action,
    });
  }
  if (projection.activeBrief === null) throw new Error('RPC host fixture Brief is missing.');
  const command = {
    version: 1,
    sessionId: ref.sessionId,
    epochId: projection.epochId,
    operationId,
    expectedBriefRevision: projection.activeBrief.revision,
    expectedReportRevision: projection.matchingReport?.report.revision ?? null,
    intentHash: `intent-${operationId}`,
    base: projection.activeBrief,
    action,
    ...(action === 'edit' && { briefText, newInputId: `input-${operationId}` }),
  };
  return BriefReviewCommandSchema.parse(command);
}

function writeConfig(projectDir: string, persistTranscript = false): void {
  const splitbriefDir = join(projectDir, SPLITBRIEF_DIR);
  mkdirSync(splitbriefDir, { recursive: true });
  const configPath = join(splitbriefDir, CONFIG_FILE);
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
      '  mode: standard',
      `  persist_transcript: ${persistTranscript ? 'true' : 'false'}`,
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

function preparedRpcExecution(input: {
  projectDir: string;
  sessionId: string;
  feature: string;
  resumeState?: WorkflowState | undefined;
}): PreparedExecution {
  const ref = { projectDir: input.projectDir, sessionId: input.sessionId };
  ensureSessionDir(ref.projectDir, ref.sessionId);
  const config = parsePreparedConfig(
    configForSessionTranscriptPolicy(loadConfig(ref.projectDir).config, ref),
  );
  const active = reactivateExistingSession(ref);
  return {
    purpose: input.resumeState === undefined ? 'new-workflow' : 'resume',
    config,
    preparationId: `rpc-test-${input.sessionId}`,
    report: {
      generatedAt: '2026-08-04T00:00:00.000Z',
      projectDir: input.projectDir,
      status: 'ready',
      counts: { ok: 1, info: 0, warning: 0, blocker: 0 },
      nextAction: { kind: 'continue', label: 'Continue', reason: 'Ready' },
      sections: [],
      metadata: {},
    },
    gates: [],
    session: { kind: 'existing', ref, active },
    runtime: {
      feature: input.feature,
      ...(input.resumeState !== undefined && { resumeState: input.resumeState }),
      allowRepoRunners: false,
      allowHooks: false,
    },
  };
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

function isTestRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

async function waitForLine(
  chunks: string[],
  predicate: (line: { type?: string; data?: unknown; command?: string; error?: string }) => boolean,
): Promise<void> {
  await vi.waitFor(() => {
    expect(parseLines(chunks).some(predicate)).toBe(true);
  });
}
describe('runRpc', () => {
  afterEach(() => {
    for (const { ref, receipt } of ownedAuthorities.splice(0)) {
      releaseStateAuthority(ref, receipt);
    }
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
      prepared: preparedRpcExecution({
        projectDir,
        sessionId: 'rpc-session',
        feature: 'ship rpc',
      }),
      deps: { input, output, runWorkflow: runWorkflowStub },
    });

    await waitForLine(
      chunks,
      (line) =>
        line.type === 'status' && isTestRecord(line.data) && line.data.pending === 'approval',
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

  it('keeps opaque resumed sessions transcript-private when current config allows transcripts', async () => {
    const projectDir = createTempDir('rpc-private-resume');
    dirs.push(projectDir);
    writeConfig(projectDir, true);
    const sessionId = '2025-04-01-session-abcdef123456';
    ensureSessionDir(projectDir, sessionId);
    const state: WorkflowState = {
      ...createInitialState('secret oauth login'),
      phase: 'planning',
    };
    saveState({ projectDir, sessionId }, state);
    const input = new PassThrough();
    const { chunks, output } = captureWritable();
    let seenPersistTranscript: boolean | undefined;
    const runWorkflowStub = async (workflowOpts: RunWorkflowOptions) => {
      seenPersistTranscript = workflowOpts.prepared.config.workflow.persistTranscript;
      workflowOpts.eventBus?.publish({
        type: 'workflow_started',
        ts: 1,
        phase: 'researching',
        feature: 'secret oauth login',
      });
    };

    await runRpc({
      prepared: preparedRpcExecution({
        projectDir,
        sessionId,
        feature: 'secret oauth login',
        resumeState: state,
      }),
      deps: { input, output, runWorkflow: runWorkflowStub },
    });

    expect(seenPersistTranscript).toBe(false);
    const serialized = chunks.join('');
    expect(serialized).not.toContain('secret oauth login');
    expect(parseLines(chunks)).toContainEqual(
      expect.objectContaining({
        type: 'event',
        data: expect.objectContaining({
          type: 'workflow_started',
          feature: '[transcript omitted]',
        }),
      }),
    );
  });

  it('correlates prompt-scoped brief review command ids across interleaved events', async () => {
    const projectDir = setupProject();
    const sessionId = 'rpc-brief-review-session';
    const ref = { projectDir, sessionId };
    saveOwnedState(ref, briefReviewState(sessionId, 'brief rpc correlation'));
    const input = new PassThrough();
    const { chunks, output } = captureWritable();
    let approved: boolean | undefined;
    let bus: EventBus | undefined;
    const runWorkflowStub = async (workflowOpts: RunWorkflowOptions) => {
      bus = workflowOpts.eventBus;
      const result = await workflowOpts.callbacks.onApprovalNeeded(
        'briefs',
        join(projectDir, 'tasks.md'),
      );
      approved = result.approved;
    };

    const run = runRpc({
      prepared: preparedRpcExecution({
        projectDir,
        sessionId,
        feature: 'brief rpc correlation',
      }),
      deps: { input, output, runWorkflow: runWorkflowStub },
    });

    await waitForLine(
      chunks,
      (line) =>
        line.type === 'status' &&
        isTestRecord(line.data) &&
        line.data.pending === 'approval' &&
        line.data.approvalType === 'briefs' &&
        typeof line.data.promptId === 'string',
    );
    const pendingLine = parseLines(chunks).find(
      (line) =>
        line.type === 'status' &&
        isTestRecord(line.data) &&
        line.data.pending === 'approval' &&
        line.data.approvalType === 'briefs' &&
        typeof line.data.promptId === 'string',
    );
    if (!isTestRecord(pendingLine?.data) || typeof pendingLine.data.promptId !== 'string') {
      throw new Error('missing prompt id');
    }
    const promptId = pendingLine.data.promptId;

    input.write(
      `${JSON.stringify({
        type: 'brief_review',
        id: 'cmd-status',
        operationId: 'op-status',
        promptId,
        command: briefReviewCommand(ref, 'status'),
      })}\n`,
    );
    await waitForLine(
      chunks,
      (line) =>
        line.type === 'status' &&
        isTestRecord(line.data) &&
        line.data.id === 'cmd-status' &&
        line.data.operationId === 'op-status' &&
        line.data.promptId === promptId &&
        line.data.pending === 'brief_review',
    );

    bus?.publish({
      type: 'warning',
      ts: 2,
      phase: 'reviewing-briefs',
      message: 'interleaved event',
    });

    input.write(
      `${JSON.stringify({
        type: 'brief_review',
        id: 'cmd-approve',
        operationId: 'op-approve',
        promptId,
        command: briefReviewCommand(ref, 'approve', 'op-approve'),
      })}\n`,
    );
    await run;

    const lines = parseLines(chunks);
    const statusIndex = lines.findIndex(
      (line) => line.type === 'status' && isTestRecord(line.data) && line.data.id === 'cmd-status',
    );
    const eventIndex = lines.findIndex(
      (line) => line.type === 'event' && isTestRecord(line.data) && line.data.type === 'warning',
    );
    const ackIndex = lines.findIndex(
      (line) =>
        line.type === 'ack' &&
        line.command === 'brief_review' &&
        isTestRecord(line.data) &&
        line.data.id === 'cmd-approve' &&
        line.data.operationId === 'op-approve' &&
        line.data.promptId === promptId &&
        line.data.action === 'approve',
    );

    expect(statusIndex).toBeGreaterThanOrEqual(0);
    expect(eventIndex).toBeGreaterThan(statusIndex);
    expect(ackIndex).toBeGreaterThan(eventIndex);
    expect(approved).toBe(true);
  });

  it('settles a current RPC Task Brief edit through the fenced projection', async () => {
    const projectDir = setupProject();
    const sessionId = 'rpc-brief-edit-envelope-session';
    const ref = { projectDir, sessionId };
    saveOwnedState(ref, briefReviewState(sessionId, 'brief rpc edit envelope'));
    const input = new PassThrough();
    const { chunks, output } = captureWritable();
    let approved: boolean | undefined;
    let action: string | undefined;
    const runWorkflowStub = async (workflowOpts: RunWorkflowOptions) => {
      const result = await workflowOpts.callbacks.onApprovalNeeded(
        'briefs',
        join(projectDir, 'tasks.md'),
      );
      approved = result.approved;
      action = result.action;
    };

    const run = runRpc({
      prepared: preparedRpcExecution({ projectDir, sessionId, feature: 'brief rpc edit envelope' }),
      deps: { input, output, runWorkflow: runWorkflowStub },
    });

    await waitForLine(
      chunks,
      (line) =>
        line.type === 'status' &&
        isTestRecord(line.data) &&
        line.data.pending === 'approval' &&
        typeof line.data.promptId === 'string',
    );
    const pendingLine = parseLines(chunks).find(
      (line) =>
        line.type === 'status' &&
        isTestRecord(line.data) &&
        line.data.pending === 'approval' &&
        typeof line.data.promptId === 'string',
    );
    if (!isTestRecord(pendingLine?.data) || typeof pendingLine.data.promptId !== 'string') {
      throw new Error('missing prompt id');
    }
    const promptId = pendingLine.data.promptId;
    input.write(
      `${JSON.stringify({
        type: 'brief_review',
        id: 'cmd-edit-envelope',
        operationId: 'op-edit-envelope',
        promptId,
        command: briefReviewCommand(ref, 'edit', 'op-edit-envelope'),
      })}\n`,
    );
    await run;

    expect(approved).toBe(false);
    expect(action).toBe('edit');
    expect(parseLines(chunks)).toContainEqual(
      expect.objectContaining({
        type: 'ack',
        command: 'brief_review',
        data: expect.objectContaining({
          id: 'cmd-edit-envelope',
          promptId,
          action: 'edit',
          status: 'accepted',
        }),
      }),
    );
  });

  it('rejects an RPC edit command whose expected Brief revision is stale', async () => {
    const projectDir = setupProject();
    const sessionId = 'rpc-brief-edit-session';
    const ref = { projectDir, sessionId };
    saveOwnedState(ref, briefReviewState(sessionId, 'brief rpc external edit'));
    const input = new PassThrough();
    const { chunks, output } = captureWritable();
    const runWorkflowStub = async (workflowOpts: RunWorkflowOptions) => {
      await workflowOpts.callbacks.onApprovalNeeded('briefs', join(projectDir, 'tasks.md'));
    };

    const run = runRpc({
      prepared: preparedRpcExecution({
        projectDir,
        sessionId,
        feature: 'brief rpc external edit',
      }),
      deps: { input, output, runWorkflow: runWorkflowStub },
    });

    await waitForLine(
      chunks,
      (line) =>
        line.type === 'status' &&
        isTestRecord(line.data) &&
        line.data.pending === 'approval' &&
        typeof line.data.promptId === 'string',
    );
    const pendingLine = parseLines(chunks).find(
      (line) =>
        line.type === 'status' &&
        isTestRecord(line.data) &&
        line.data.pending === 'approval' &&
        typeof line.data.promptId === 'string',
    );
    if (!isTestRecord(pendingLine?.data) || typeof pendingLine.data.promptId !== 'string') {
      throw new Error('missing prompt id');
    }
    const promptId = pendingLine.data.promptId;

    const current = briefReviewCommand(ref, 'edit', 'op-edit');
    if (current.action !== 'edit') throw new Error('expected an edit command');
    input.write(
      `${JSON.stringify({
        type: 'brief_review',
        id: 'cmd-edit-stale',
        promptId,
        operationId: 'op-edit-stale',
        command: {
          ...current,
          operationId: 'op-edit-stale',
          expectedBriefRevision: current.expectedBriefRevision + 1,
          base: { ...current.base, revision: current.base.revision + 1 },
        },
      })}\n`,
    );
    await waitForLine(
      chunks,
      (line) =>
        line.type === 'error' && isTestRecord(line.data) && line.data.code === 'stale-revision',
    );

    input.write(
      `${JSON.stringify({
        type: 'brief_review',
        id: 'cmd-edit',
        promptId,
        operationId: 'op-edit',
        command: current,
      })}\n`,
    );
    await run;

    expect(
      parseLines(chunks).filter(
        (line) =>
          line.type === 'ack' && isTestRecord(line.data) && line.data.id === 'cmd-edit-stale',
      ),
    ).toEqual([]);
  });

  it('answers status commands with the persisted workflow state', async () => {
    const projectDir = setupProject();
    const sessionId = 'rpc-status-session';
    saveOwnedState(
      { projectDir, sessionId },
      { ...createInitialState('status feature'), phase: 'planning' },
    );
    const input = new PassThrough();
    const { chunks, output } = captureWritable();
    let finishWorkflow: (() => void) | undefined;
    const workflowDone = new Promise<void>((resolve) => {
      finishWorkflow = resolve;
    });
    const runWorkflowStub = async () => workflowDone;

    const run = runRpc({
      prepared: preparedRpcExecution({ projectDir, sessionId, feature: 'status feature' }),
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
    saveOwnedState({ projectDir, sessionId }, makeStateWithMixedQueue('status queue feature'));
    const input = new PassThrough();
    const { chunks, output } = captureWritable();
    let finishWorkflow: (() => void) | undefined;
    const workflowDone = new Promise<void>((resolve) => {
      finishWorkflow = resolve;
    });
    const runWorkflowStub = async () => workflowDone;

    const run = runRpc({
      prepared: preparedRpcExecution({ projectDir, sessionId, feature: 'status queue feature' }),
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
      prepared: preparedRpcExecution({ projectDir, sessionId, feature: 'slash queue feature' }),
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
    let action: string | undefined;
    let comment: string | undefined;
    const runWorkflowStub = async (workflowOpts: RunWorkflowOptions) => {
      const result = await workflowOpts.callbacks.onApprovalNeeded(
        'spec',
        join(projectDir, 'spec.md'),
      );
      approved = result.approved;
      action = result.action;
      comment = result.comment;
    };

    const run = runRpc({
      prepared: preparedRpcExecution({
        projectDir,
        sessionId: 'rpc-regenerate-session',
        feature: 'regenerate test',
      }),
      deps: { input, output, runWorkflow: runWorkflowStub },
    });

    await waitForLine(
      chunks,
      (line) =>
        line.type === 'status' && isTestRecord(line.data) && line.data.pending === 'approval',
    );
    expect(approved).toBeUndefined();

    input.write('{"type":"regenerate","comment":"needs work"}\n');
    await run;

    expect(approved).toBe(false);
    expect(action).toBe('revise');
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
      prepared: preparedRpcExecution({
        projectDir,
        sessionId: 'rpc-abort-session',
        feature: 'abort test',
      }),
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
    saveOwnedState({ projectDir, sessionId }, stateWithApplyingRecovery);

    const input = new PassThrough();
    const { chunks, output } = captureWritable();
    const runWorkflowStub = async () => {};

    await runRpc({
      prepared: preparedRpcExecution({
        projectDir,
        sessionId,
        feature: 'applying recovery',
        resumeState: stateWithApplyingRecovery,
      }),
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
    saveOwnedState({ projectDir, sessionId }, stateWithRecovery);

    const input = new PassThrough();
    const { chunks, output } = captureWritable();

    const runWorkflowStub = async () => {};

    const run = runRpc({
      prepared: preparedRpcExecution({
        projectDir,
        sessionId,
        feature: 'recovery feature',
        resumeState: stateWithRecovery,
      }),
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

  it('reopens paused recovery instead of stopping the RPC run', async () => {
    const projectDir = setupProject();
    const sessionId = 'rpc-paused-recovery-session';
    const stateWithPausedRecovery: WorkflowState = {
      ...createInitialState('paused recovery feature'),
      phase: 'implementing',
      tasks: [makeTask({ id: 'T001', status: 'failed' })],
      pendingRecovery: makeRecoveryIssue({
        status: 'paused',
        selectedAction: 'pause-run',
        taskId: taskId('T001'),
        affectedTaskIds: [taskId('T001')],
        availableActions: ['retry-same-worker', 'pause-run', 'abort-workflow'],
        recommendedAction: 'retry-same-worker',
      }),
    };
    saveOwnedState({ projectDir, sessionId }, stateWithPausedRecovery);

    const input = new PassThrough();
    const { chunks, output } = captureWritable();
    let savedStateForRun: WorkflowState | undefined;
    const runWorkflowStub = async (workflowOpts: RunWorkflowOptions) => {
      savedStateForRun = workflowOpts.savedState;
    };

    const run = runRpc({
      prepared: preparedRpcExecution({
        projectDir,
        sessionId,
        feature: 'paused recovery feature',
        resumeState: stateWithPausedRecovery,
      }),
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

    input.write('{"type":"recovery","action":"retry-same-worker"}\n');
    await run;

    expect(savedStateForRun?.pendingRecovery).toBeUndefined();
    expect(savedStateForRun?.tasks[0]?.status).toBe('pending');
    expect(parseLines(chunks)).toContainEqual(
      expect.objectContaining({
        type: 'ack',
        command: 'recovery',
        data: expect.objectContaining({ action: 'retry-same-worker' }),
      }),
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
      prepared: preparedRpcExecution({
        projectDir,
        sessionId: 'rpc-no-recovery-session',
        feature: 'no recovery prompt',
      }),
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
    saveOwnedState({ projectDir, sessionId }, stateWithRecovery);

    const input = new PassThrough();
    const { chunks, output } = captureWritable();
    const run = runRpc({
      prepared: preparedRpcExecution({
        projectDir,
        sessionId,
        feature: 'invalid recovery feature',
        resumeState: stateWithRecovery,
      }),
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
    saveOwnedState({ projectDir, sessionId }, stateWithRecovery);

    const input = new PassThrough();
    const { chunks, output } = captureWritable();
    const run = runRpc({
      prepared: preparedRpcExecution({
        projectDir,
        sessionId,
        feature: 'double recovery feature',
        resumeState: stateWithRecovery,
      }),
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

  it('keeps raw revise feedback transient while restarting the RPC workflow turn', async () => {
    const projectDir = setupProject();
    const sessionId = 'rpc-revise-session';
    const sentinel = 'rpc-raw-revise-secret-81427';
    const state: WorkflowState = {
      ...createInitialState('revise rpc feature'),
      phase: 'reviewing-plan',
    };
    saveOwnedState({ projectDir, sessionId }, state);

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
      prepared: preparedRpcExecution({
        projectDir,
        sessionId,
        feature: 'revise rpc feature',
        resumeState: state,
      }),
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
    saveOwnedState({ projectDir, sessionId }, state);

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
      prepared: preparedRpcExecution({
        projectDir,
        sessionId,
        feature: 'approval revise rpc feature',
        resumeState: state,
      }),
      deps: { input, output, runWorkflow: runWorkflowStub },
    });

    await waitForLine(
      chunks,
      (line) =>
        line.type === 'status' && isTestRecord(line.data) && line.data.pending === 'approval',
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
    saveOwnedState({ projectDir, sessionId }, stateWithRecovery);

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
      prepared: preparedRpcExecution({
        projectDir,
        sessionId,
        feature: 'recovery revise rpc feature',
        resumeState: stateWithRecovery,
      }),
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
      prepared: preparedRpcExecution({
        projectDir,
        sessionId: 'rpc-queue-clear-session',
        feature: 'queue clear test',
      }),
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
      prepared: preparedRpcExecution({
        projectDir,
        sessionId: 'rpc-yolo-session',
        feature: 'rpc yolo active state test',
      }),
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
      prepared: preparedRpcExecution({
        projectDir,
        sessionId: 'rpc-slash-error-session',
        feature: 'slash error test',
      }),
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
      prepared: preparedRpcExecution({
        projectDir,
        sessionId: 'rpc-slash-typo-session',
        feature: 'slash typo test',
      }),
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
      prepared: preparedRpcExecution({
        projectDir,
        sessionId: 'rpc-eof-session',
        feature: 'eof test',
      }),
      deps: { input, output, runWorkflow: runWorkflowStub },
    });

    input.end();
    finishWorkflow?.();
    await run;

    expect(parseLines(chunks).filter((line) => line.type === 'error')).toEqual([]);
  });

  it('rejects pending approval gate when stdin closes unexpectedly', async () => {
    const projectDir = setupProject();
    const input = new PassThrough();
    const { chunks, output } = captureWritable();
    const runWorkflowStub = async (workflowOpts: RunWorkflowOptions) => {
      await workflowOpts.callbacks.onApprovalNeeded('spec', join(projectDir, 'spec.md'));
    };

    const run = runRpc({
      prepared: preparedRpcExecution({
        projectDir,
        sessionId: 'rpc-gate-close-session',
        feature: 'gate-close test',
      }),
      deps: { input, output, runWorkflow: runWorkflowStub },
    });

    await waitForLine(
      chunks,
      (line) =>
        line.type === 'status' && isTestRecord(line.data) && line.data.pending === 'approval',
    );

    input.end();
    await expect(run).rejects.toSatisfy((err: unknown) => {
      if (!isRpcShuttingDown(err)) return false;
      expect(err.kind).toBe('rpc-shutting-down');
      expect(err.message).toBe('stdin closed unexpectedly');
      expect(err.data).toEqual({ reason: 'stdin closed unexpectedly' });
      return true;
    });
  });
});
