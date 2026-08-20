import { chmodSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeRecoveryIssue } from '#testing/helpers/factories/recovery.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { CONFIG_FILE, SPLITBRIEF_DIR } from '../../core/paths.js';
import { ensureSessionDir } from '../../core/paths-io.js';
import type { Config } from '../../core/schemas/config.js';
import { createBriefRecoveryState } from '../../engine/orchestrator/planning/brief-recovery.js';
import type { BriefAdmissionInput } from '../../core/schemas/brief-recovery.js';
import type { WorkflowState } from '../../core/schemas/workflow.js';
import { createInitialState } from '../../core/state/machine.js';
import { acquireStateAuthority, releaseStateAuthority } from '../../core/state/authority.js';
import { saveState } from '../../core/state/persistence.js';
import type { RunWorkflowOptions } from '../../engine/orchestrator/run/init.js';
import { PLANNER_ARTIFACT_MAX_BYTES } from '../../engine/runners/types.js';
import {
  parsePreparedConfig,
  type PreparedExecution,
  type RunnerGate,
} from '../../engine/runners/prepared-execution.js';
import { loadConfig } from '../../core/config/load/io.js';
import { matches } from '../../utils/error.js';
import { RPC_MAX_FRAME_BYTES } from './types.js';
import { runRpc } from './run/host.js';

const { applyRecoveryActionMock, createPlannerMock } = vi.hoisted(() => ({
  applyRecoveryActionMock: vi.fn(),
  createPlannerMock: vi.fn(),
}));

vi.mock('../../engine/runners/factory.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../engine/runners/factory.js')>();
  return { ...actual, createPlanner: createPlannerMock };
});

vi.mock('../../engine/orchestrator/recovery/actions.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../engine/orchestrator/recovery/actions.js')>();
  return {
    ...actual,
    applyRecoveryAction: (
      options: Parameters<typeof actual.applyRecoveryAction>[0],
    ): ReturnType<typeof actual.applyRecoveryAction> => {
      applyRecoveryActionMock(options);
      return actual.applyRecoveryAction(options);
    },
  };
});

const isRpcShuttingDown = matches('rpc-shutting-down');

let dirs: string[] = [];

function writeConfig(projectDir: string, mode = 'standard'): void {
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
      'validation:',
      '  typecheck: false',
      '  lint: false',
      '  test: false',
      '  test_command: "noop"',
      'workflow:',
      '  approve: default',
      '  max_retries: 3',
      `  mode: ${mode}`,
    ].join('\n'),
  );
  chmodSync(configPath, 0o600);
}

function preparedExecution(
  projectDir: string,
  sessionId: string,
  overrides: Readonly<{
    config?: Config | undefined;
    gates?: readonly RunnerGate[] | undefined;
    resumeState?: WorkflowState | undefined;
  }> = {},
): PreparedExecution {
  const config = parsePreparedConfig(overrides.config ?? loadConfig(projectDir).config);
  const active = {
    version: 1 as const,
    sessionId,
    generation: '33333333-3333-4333-8333-333333333333',
  };
  return {
    purpose: 'new-workflow',
    config,
    preparationId: 'rpc-preparation',
    report: {
      generatedAt: '2026-08-04T00:00:00.000Z',
      projectDir,
      status: 'ready',
      counts: { ok: 1, info: 0, warning: 0, blocker: 0 },
      nextAction: { kind: 'continue', label: 'Continue', reason: 'Ready' },
      sections: [],
      metadata: {},
    },
    gates: overrides.gates ?? [],
    session: {
      kind: 'new',
      ref: { projectDir, sessionId },
      ownership: active,
      active,
    },
    runtime: {
      feature: 'RPC prepared feature',
      ...(overrides.resumeState !== undefined && { resumeState: overrides.resumeState }),
      allowRepoRunners: false,
      allowHooks: false,
    },
  };
}

function briefReviewState(sessionId: string): WorkflowState {
  const admission: BriefAdmissionInput = {
    sessionId,
    origin: { mode: 'standard', entry: 'initial' },
    continuation: { version: 1, kind: 'approval', mode: 'standard', entry: 'initial' },
    activeBrief: { revision: 1, hash: 'rpc-brief-hash', path: 'tasks.md' },
    report: {
      briefHash: 'rpc-brief-hash',
      report: { revision: 1, hash: 'rpc-report-hash', path: 'brief-quality.json' },
      ruleVersion: 'brief-quality-v1',
      issues: [],
      errorCount: 0,
    },
    qualityPolicyVersion: 'brief-quality-v1',
  };
  return {
    ...createInitialState('rpc-brief-review'),
    phase: 'reviewing-briefs',
    briefRecovery: createBriefRecoveryState(admission, { epochId: 'rpc-epoch' }),
  };
}

describe('runRpc', () => {
  afterEach(() => {
    for (const dir of dirs) cleanupTempDir(dir);
    dirs = [];
  });

  it('RPC start uses the shared headless preparation policy', async () => {
    const projectDir = createTempDir('rpc-run-prepared');
    dirs.push(projectDir);
    writeConfig(projectDir);
    const prepared = preparedExecution(projectDir, 'rpc-prepared-session');
    const input = new PassThrough();
    const output = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    let received: PreparedExecution | undefined;

    await runRpc({
      prepared,
      deps: {
        input,
        output,
        runWorkflow: async (options) => {
          received = options.prepared;
        },
      },
    });

    expect(received).toBe(prepared);
    expect(received?.runtime.feature).toBe('RPC prepared feature');
  });

  it.each([
    ['deleted', (path: string) => unlinkSync(path)],
    ['invalid', (path: string) => writeFileSync(path, 'version: invalid\nplanner: [')],
  ])(
    'runs from the prepared config when the disk config is %s after admission',
    async (_mutation, mutateConfig) => {
      const projectDir = createTempDir('rpc-run-prepared-config');
      dirs.push(projectDir);
      writeConfig(projectDir);
      const prepared = preparedExecution(projectDir, 'rpc-prepared-config-session');
      const configPath = join(projectDir, SPLITBRIEF_DIR, CONFIG_FILE);
      mutateConfig(configPath);
      const input = new PassThrough();
      const chunks: string[] = [];
      const output = new Writable({
        write(chunk, _encoding, callback) {
          chunks.push(String(chunk));
          callback();
        },
      });
      const workflowTurn = Promise.withResolvers<void>();
      let received: PreparedExecution | undefined;

      const run = runRpc({
        prepared,
        deps: {
          input,
          output,
          runWorkflow: async (options) => {
            received = options.prepared;
            await workflowTurn.promise;
          },
        },
      });

      await vi.waitFor(() => {
        expect(received).toBe(prepared);
      });
      input.write('{"type":"slash","command":"/yolo"}\n');
      await vi.waitFor(() => {
        expect(chunks.join('')).toContain('"command":"slash"');
      });
      workflowTurn.resolve();
      await run;

      expect(received).toBe(prepared);
      expect(received?.config).toBe(prepared.config);
      expect(received?.config.workflow.mode).toBe('standard');
    },
  );

  it('rejects a pending approval gate when stdin closes unexpectedly', async () => {
    const projectDir = createTempDir('rpc-run-gate-close');
    dirs.push(projectDir);
    writeConfig(projectDir);
    const input = new PassThrough();
    const output = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    const runWorkflowStub = async (workflowOpts: RunWorkflowOptions) => {
      await workflowOpts.callbacks.onApprovalNeeded('spec', join(projectDir, 'spec.md'));
    };

    const run = runRpc({
      prepared: preparedExecution(projectDir, 'rpc-gate-close-session'),
      deps: { input, output, runWorkflow: runWorkflowStub },
    });

    await vi.waitFor(() => {
      expect(input.readable).toBe(true);
    });

    input.end();
    await expect(run).rejects.toSatisfy((err: unknown) => {
      if (!isRpcShuttingDown(err)) return false;
      expect(err.kind).toBe('rpc-shutting-down');
      expect(err.message).toBe('stdin closed unexpectedly');
      expect(err.data).toEqual({ reason: 'stdin closed unexpectedly' });
      return true;
    });
  });

  it('observes only the live owner state through its receipt-bound resume seam', async () => {
    const projectDir = createTempDir('rpc-owner-hydration');
    dirs.push(projectDir);
    writeConfig(projectDir);
    const sessionId = 'rpc-owner-hydration-session';
    const ref = { projectDir, sessionId };
    ensureSessionDir(projectDir, sessionId);
    const input = new PassThrough();
    const chunks: string[] = [];
    const output = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(String(chunk));
        callback();
      },
    });
    const workflowTurn = Promise.withResolvers<void>();
    let ownerReceipt: ReturnType<typeof acquireStateAuthority> | undefined;

    const run = runRpc({
      prepared: preparedExecution(projectDir, sessionId),
      deps: {
        input,
        output,
        runWorkflow: async () => {
          saveState(ref, createInitialState('owner-hydration'));
          ownerReceipt = acquireStateAuthority({ ref, purpose: 'resume' });
          await workflowTurn.promise;
        },
      },
    });

    await vi.waitFor(() => expect(ownerReceipt?.kind).toBe('fenced'));
    input.write('{"type":"status"}\n');
    await vi.waitFor(() => {
      const status = chunks
        .join('')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .find((response) => response.type === 'status');
      expect(status).toMatchObject({
        data: {
          sessionId,
          state: { stateVersion: 4, stateRevision: 1, stateFence: { token: 1 } },
        },
      });
    });

    workflowTurn.resolve();
    await run;
    if (ownerReceipt?.kind === 'fenced') releaseStateAuthority(ref, ownerReceipt.receipt);
  });

  it('treats an output sink failure as transport shutdown without a recovery write', async () => {
    const projectDir = createTempDir('rpc-output-failure');
    dirs.push(projectDir);
    writeConfig(projectDir);
    const input = new PassThrough();
    const output = new Writable({
      write(_chunk, _encoding, callback) {
        callback(new Error('rpc output failed'));
      },
    });
    let providerCalls = 0;

    const run = runRpc({
      prepared: preparedExecution(projectDir, 'rpc-output-failure-session'),
      deps: {
        input,
        output,
        runWorkflow: async (options) => {
          await options.callbacks.onQuestionAsked?.(
            { id: 'private-question', type: 'input', text: 'private question' },
            1,
            1,
          );
          providerCalls += 1;
        },
      },
    });

    await expect(run).rejects.toSatisfy((cause: unknown) => {
      if (!isRpcShuttingDown(cause)) return false;
      expect(cause.message).toContain('output stream error');
      return true;
    });
    expect(providerCalls).toBe(0);
  });

  it('replays exact artifact approval text through RPC status without a pathname', async () => {
    const projectDir = createTempDir('rpc-run-artifact-approval');
    dirs.push(projectDir);
    writeConfig(projectDir);
    const input = new PassThrough();
    const chunks: string[] = [];
    const output = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(String(chunk));
        callback();
      },
    });
    let approvalResult: unknown;
    const sentinel = 'artifact-rpc-transient-28017';
    const artifactText = `${'\u0000'.repeat(
      PLANNER_ARTIFACT_MAX_BYTES - Buffer.byteLength(sentinel, 'utf8'),
    )}${sentinel}`;
    const review = Object.freeze({ label: 'Custom planner artifact', text: artifactText });
    const runWorkflowStub = async (workflowOpts: RunWorkflowOptions) => {
      approvalResult = await workflowOpts.callbacks.onApprovalNeeded('artifact', review);
    };

    const run = runRpc({
      prepared: preparedExecution(projectDir, 'rpc-artifact-session'),
      deps: { input, output, runWorkflow: runWorkflowStub },
    });

    await vi.waitFor(() => {
      const response = chunks
        .join('')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .find((entry) => entry.type === 'status' && entry.data?.approvalType === 'artifact');
      expect(response).toMatchObject({
        data: {
          pending: 'approval',
          approvalType: 'artifact',
          review,
          allowedCommands: [],
        },
      });
    });

    input.write('{"type":"status"}\n');
    await vi.waitFor(() => {
      const lines = chunks.join('').split('\n').filter(Boolean);
      const artifactLines = lines.filter((line) => {
        const response = JSON.parse(line);
        return response.type === 'status' && response.data?.approvalType === 'artifact';
      });
      expect(artifactLines).toHaveLength(2);
      for (const line of artifactLines) {
        const response = JSON.parse(line);
        expect(response.data).toMatchObject({
          pending: 'approval',
          approvalType: 'artifact',
          review,
          allowedCommands: [],
        });
        expect(response.data).not.toHaveProperty('filePath');
        expect(Buffer.byteLength(`${line}\n`, 'utf8')).toBeLessThanOrEqual(RPC_MAX_FRAME_BYTES);
      }
    });

    input.write('{"type":"approve"}\n');
    await run;

    expect(approvalResult).toEqual({ approved: true });
    const responses = chunks
      .join('')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    expect(
      JSON.stringify(responses.filter((response) => response.type !== 'status')),
    ).not.toContain(sentinel);
    expect(chunks.join('')).toContain('"command":"approve"');
  });

  it('returns an RPC error instead of acknowledging a slash edit after the config changes', async () => {
    const projectDir = createTempDir('rpc-run-config-conflict');
    dirs.push(projectDir);
    writeConfig(projectDir);
    const input = new PassThrough();
    const chunks: string[] = [];
    const output = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(String(chunk));
        callback();
      },
    });
    let workflowStarted = false;
    let completeWorkflow = () => {};
    const workflowCompletion = new Promise<void>((resolve) => {
      completeWorkflow = resolve;
    });
    const runWorkflowStub = async () => {
      workflowStarted = true;
      await workflowCompletion;
    };

    const run = runRpc({
      prepared: preparedExecution(projectDir, 'rpc-config-conflict-session'),
      deps: { input, output, runWorkflow: runWorkflowStub },
    });

    await vi.waitFor(() => {
      expect(workflowStarted).toBe(true);
    });
    writeConfig(projectDir, 'quick');
    const externalBytes = readFileSync(join(projectDir, SPLITBRIEF_DIR, CONFIG_FILE), 'utf8');
    input.write('{"type":"slash","command":"/mode speckit"}\n');

    await vi.waitFor(() => {
      expect(chunks.join('')).toContain('Reload configuration before retrying.');
    });
    const responses = chunks
      .join('')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    expect(responses).not.toContainEqual(
      expect.objectContaining({ type: 'ack', command: 'slash' }),
    );
    expect(readFileSync(join(projectDir, SPLITBRIEF_DIR, CONFIG_FILE), 'utf8')).toBe(externalBytes);

    completeWorkflow();
    await run;
  });

  it('RPC compaction and recovery reuse prepared runner authority after config changes', async () => {
    const projectDir = createTempDir('rpc-run-prepared-authority');
    dirs.push(projectDir);
    writeConfig(projectDir);
    const sessionId = 'rpc-prepared-authority-session';
    ensureSessionDir(projectDir, sessionId);
    const task = makeTask({ id: 'T001' });
    const resumeState: WorkflowState = {
      ...createInitialState('rpc-prepared-authority'),
      phase: 'implementing',
      tasks: [task],
      pendingRecovery: makeRecoveryIssue({
        reason: 'context-overflow',
        phase: 'implementing',
        selectedImplementerProfile: 'small',
        facts: { routeBiggerProfile: 'bigger' },
        availableActions: ['route-bigger-worker'],
        recommendedAction: 'route-bigger-worker',
      }),
    };
    saveState({ projectDir, sessionId }, resumeState);
    const ownerAuthority = acquireStateAuthority({
      ref: { projectDir, sessionId },
      purpose: 'resume',
    });
    expect(ownerAuthority.kind).toBe('fenced');
    const config = makeConfig({
      planner: {
        kind: 'api',
        provider: 'openrouter',
        apiBase: 'https://openrouter.ai/api/v1',
        model: 'planner-model',
        apiKey: 'prepared-secret',
      },
      implementerProfiles: {
        default: 'small',
        profiles: {
          small: {
            kind: 'api',
            provider: 'ollama',
            apiBase: 'http://localhost:11434/v1',
            model: 'small-model',
          },
          bigger: {
            kind: 'api',
            provider: 'ollama',
            apiBase: 'http://localhost:11434/v1',
            model: 'bigger-model',
          },
        },
      },
    });
    const gates = Object.freeze<RunnerGate[]>([
      {
        kind: 'api',
        slot: { role: 'planner' },
        preparationId: 'rpc-preparation',
        provider: 'openrouter',
        endpointOrigin: 'https://openrouter.ai',
      },
    ]);
    const prepared = preparedExecution(projectDir, sessionId, {
      config,
      gates,
      resumeState,
    });
    const input = new PassThrough();
    const chunks: string[] = [];
    const output = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(String(chunk));
        callback();
      },
    });
    const workflowTurn = Promise.withResolvers<void>();
    let receivedOptions: RunWorkflowOptions | undefined;
    applyRecoveryActionMock.mockReset();
    createPlannerMock.mockReset();
    createPlannerMock.mockResolvedValue({
      capabilities: { supportsSelfSummarisation: false },
    });

    const run = runRpc({
      prepared,
      deps: {
        input,
        output,
        runWorkflow: async (options) => {
          receivedOptions = options;
          await workflowTurn.promise;
        },
      },
    });

    await vi.waitFor(() => {
      expect(chunks.join('')).toContain('"pending":"recovery"');
    });
    writeConfig(projectDir, 'quick');
    input.write('{"type":"recovery","action":"route-bigger-worker"}\n');

    await vi.waitFor(() => {
      expect(receivedOptions).toBeDefined();
    });
    expect(receivedOptions?.prepared).toBe(prepared);
    expect(receivedOptions?.prepared.config).toBe(prepared.config);
    expect(receivedOptions?.prepared.gates).toBe(prepared.gates);
    expect(receivedOptions?.retryProfileOverride).toBe('bigger');
    expect(Object.isFrozen(prepared.config)).toBe(true);
    expect(applyRecoveryActionMock).toHaveBeenCalledOnce();
    expect(applyRecoveryActionMock.mock.calls[0]?.[0]?.config).toBe(prepared.config);

    input.write('{"type":"slash","command":"/compact-transcript"}\n');
    await vi.waitFor(() => {
      expect(createPlannerMock).toHaveBeenCalledOnce();
    });
    const [compactionConfig, compactionAuthority] = createPlannerMock.mock.calls[0] ?? [];
    expect(compactionConfig).toBe(prepared.config);
    expect(compactionAuthority).toMatchObject({
      preparationId: prepared.preparationId,
      slot: { role: 'planner' },
    });
    expect(compactionAuthority?.gates).toBe(prepared.gates);
    await vi.waitFor(() => {
      expect(chunks.join('')).toContain('does not support transcript compaction');
    });

    workflowTurn.resolve();
    await run;
    if (ownerAuthority.kind === 'fenced') {
      releaseStateAuthority({ projectDir, sessionId }, ownerAuthority.receipt);
    }
  });

  it('routes current Brief Review commands through the authoritative host projection', async () => {
    const projectDir = createTempDir('rpc-brief-review-authority');
    dirs.push(projectDir);
    writeConfig(projectDir);
    const sessionId = 'rpc-brief-review-authority-session';
    const ref = { projectDir, sessionId };
    ensureSessionDir(projectDir, sessionId);
    saveState(ref, briefReviewState(sessionId));
    const ownerAuthority = acquireStateAuthority({ ref, purpose: 'resume' });
    expect(ownerAuthority.kind).toBe('fenced');

    const input = new PassThrough();
    const chunks: string[] = [];
    const output = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(String(chunk));
        callback();
      },
    });
    let approvalResult: unknown;
    let workflowStarted = false;

    const run = runRpc({
      prepared: preparedExecution(projectDir, sessionId),
      deps: {
        input,
        output,
        runWorkflow: async (options) => {
          workflowStarted = true;
          approvalResult = await options.callbacks.onApprovalNeeded(
            'briefs',
            join(projectDir, 'tasks.md'),
          );
        },
      },
    });

    await vi.waitFor(() => expect(workflowStarted).toBe(true));
    input.write(
      `${JSON.stringify({
        type: 'brief_review',
        id: 'rpc-stale-status',
        command: { version: 1, sessionId, epochId: 'stale-epoch', action: 'status' },
      })}\n`,
    );
    await vi.waitFor(() => {
      const response = chunks
        .join('')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .find((entry) => entry.type === 'error');
      expect(response).toEqual({
        type: 'error',
        error: 'RPC command epoch does not match the current projection.',
        data: { code: 'stale-epoch' },
      });
    });

    input.write(
      `${JSON.stringify({
        type: 'brief_review',
        id: 'rpc-current-status',
        command: { version: 1, sessionId, epochId: 'rpc-epoch', action: 'status' },
      })}\n`,
    );
    await vi.waitFor(() => {
      const response = chunks
        .join('')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .find((entry) => entry.data?.action === 'status');
      expect(response).toMatchObject({
        type: 'status',
        data: {
          sessionId,
          epochId: 'rpc-epoch',
          action: 'status',
          pending: 'brief_review',
          allowedCommands: expect.arrayContaining(['approve']),
        },
      });
    });

    const operationId = 'rpc-brief-approval-operation';
    input.write(
      `${JSON.stringify({
        type: 'brief_review',
        id: 'rpc-current-approve',
        operationId,
        command: {
          version: 1,
          sessionId,
          epochId: 'rpc-epoch',
          operationId,
          expectedBriefRevision: 1,
          expectedReportRevision: 1,
          intentHash: 'rpc-approval-intent',
          base: { revision: 1, hash: 'rpc-brief-hash', path: 'tasks.md' },
          baseReport: {
            revision: 1,
            hash: 'rpc-report-hash',
            path: 'brief-quality.json',
          },
          action: 'approve',
        },
      })}\n`,
    );
    await vi.waitFor(() => {
      const response = chunks
        .join('')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .find((entry) => entry.type === 'ack' && entry.command === 'brief_review');
      expect(response).toMatchObject({
        type: 'ack',
        command: 'brief_review',
        data: { action: 'approve', status: 'accepted' },
      });
    });

    await run;
    expect(approvalResult).toEqual({ approved: true });
    if (ownerAuthority.kind === 'fenced') releaseStateAuthority(ref, ownerAuthority.receipt);
  });

  it('preserves the typed authority error on the RPC wire', async () => {
    const projectDir = createTempDir('rpc-brief-review-no-authority');
    dirs.push(projectDir);
    writeConfig(projectDir);
    const sessionId = 'rpc-brief-review-no-authority-session';
    const input = new PassThrough();
    const chunks: string[] = [];
    const output = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(String(chunk));
        callback();
      },
    });
    const workflowTurn = Promise.withResolvers<void>();
    let workflowStarted = false;

    const run = runRpc({
      prepared: preparedExecution(projectDir, sessionId),
      deps: {
        input,
        output,
        runWorkflow: async () => {
          workflowStarted = true;
          await workflowTurn.promise;
        },
      },
    });

    await vi.waitFor(() => expect(workflowStarted).toBe(true));
    input.write(
      `${JSON.stringify({
        type: 'brief_review',
        id: 'rpc-authority-missing',
        command: { version: 1, sessionId, epochId: 'rpc-epoch', action: 'status' },
      })}\n`,
    );
    await vi.waitFor(() => {
      const errors = chunks
        .join('')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .filter((entry) => entry.type === 'error');
      expect(errors).toEqual([
        {
          type: 'error',
          error: 'Brief review command requires the authoritative current-v4 projection.',
          data: { code: 'authority-unavailable' },
        },
      ]);
    });

    workflowTurn.resolve();
    await run;
  });
});
