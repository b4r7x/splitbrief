import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { ensureSessionDir } from '../../../../src/core/paths-io.js';
import { sessionDir } from '../../../../src/core/paths.js';
import { createInitialState } from '../../../../src/core/state/machine.js';
import type { WorkflowState } from '../../../../src/core/schemas/workflow.js';
import {
  BriefRecoveryCommandSchema,
  BriefRecoveryProjectionV1Schema,
  BriefRecoveryStateViewSchema,
  type BriefAdmissionInput,
  type BriefRecoveryCommand,
  type BriefRecoveryController,
  type BriefRecoveryControllerDeps,
  type BriefRecoveryProjectionV1,
  type BriefRecoveryStateView,
  type BudgetReservation,
  type EvidenceRef,
  type RecoveryCallEstimate,
  type RecoveryProviderRequest,
  type RecoveryProviderResult,
  type RecoveryResultV1,
  type StateAuthorityReceipt,
} from '../../../../src/core/schemas/brief-recovery.js';
import {
  BriefReviewCommandSchema,
  type BriefReviewCommandAction,
} from '../../../../src/core/schemas/brief-review-command.js';
import type {
  BriefOwnerCommitInput,
  BriefOwnerCommitResult,
  ConfigRevision,
} from '../../../../src/core/schemas/brief-owner.js';
import { loadState, saveState } from '../../../../src/core/state/persistence.js';
import { PhaseSchema } from '../../../../src/core/schemas/enums.js';
import { createBriefRecoveryController } from '../../../../src/engine/orchestrator/planning/brief-recovery-controller.js';
import { createCommandReader, createRpcOperationDeduper } from '../../../../src/cli/rpc/reader.js';
import { createResponseWriter } from '../../../../src/cli/rpc/writer.js';
import type { RpcCommand, RpcResponse } from '../../../../src/cli/rpc/types.js';
import type { BriefReviewCommand } from '../../../../src/core/schemas/brief-review-command.js';

const NOW = '2026-08-13T00:00:00.000Z';

type ProviderMode = 'completed' | 'ambiguous';

type RpcLine = RpcResponse & { data?: Record<string, unknown> };

type RpcClient = {
  readonly chunks: string[];
  readonly send: (command: RpcCommand) => void;
  readonly close: () => void;
};

type Scenario = {
  readonly projectDir: string;
  readonly sessionId: string;
  readonly controller: BriefRecoveryController;
  readonly admission: RecoveryResultV1;
  readonly providerCalls: () => number;
  readonly implementationCalls: () => number;
  readonly currentAuthority: () => StateAuthorityReceipt;
  readonly currentState: () => WorkflowState;
  readonly attach: (label: string, controller?: BriefRecoveryController) => RpcClient;
};

const tempDirs: string[] = [];
const clients: RpcClient[] = [];

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function ref(value: string, path: string, revision = 1): EvidenceRef {
  return { revision, hash: hash(value), path };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseLines(chunks: readonly string[]): RpcLine[] {
  return chunks
    .join('')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RpcLine);
}

async function waitForLine(
  client: RpcClient,
  predicate: (line: RpcLine) => boolean,
): Promise<RpcLine> {
  await vi.waitFor(() => {
    expect(parseLines(client.chunks).some(predicate)).toBe(true);
  });
  const line = parseLines(client.chunks).find(predicate);
  if (line === undefined) throw new Error('RPC response did not arrive');
  return line;
}

function authority(sessionId: string, stateRevision = 0): StateAuthorityReceipt {
  return {
    kind: 'usable',
    sessionId,
    ownerId: 'rpc-test-owner',
    pid: 1,
    processStart: 'rpc-test-process',
    runId: 'rpc-test-run',
    acquisitionId: 'rpc-test-acquisition',
    fence: 1,
    stateRevision,
    stateDigest: hash(`${sessionId}:${stateRevision}`),
  };
}

function reservation(key: {
  sessionId: string;
  epochId: string;
  operationId: string;
}): BudgetReservation {
  return {
    accountingKey: { ...key, generation: 0 },
    amount: 0.1,
    state: 'reserved',
    usageApplied: false,
    appliedUsage: null,
    history: [{ state: 'reserved', at: NOW, reason: 'accepted' }],
  };
}

function budgetDependencies(): Pick<BriefRecoveryControllerDeps, 'budget'> {
  return {
    budget: {
      estimate: (): RecoveryCallEstimate => ({
        kind: 'finite',
        budgetUnit: 'usd',
        inputTokens: 16,
        outputTokens: 64,
        amount: 0.1,
        pricingIdentity: 'rpc-test-pricing',
      }),
      reserve: ({ accountingKey }) => ({
        kind: 'reserved',
        reservation: reservation(accountingKey),
      }),
      reconcile: ({ reservation: resource }) => ({
        reservation: resource,
        usageApplied: false,
        appliedAmount: 0,
      }),
      terminalCharge: ({ reservation: resource }) => ({
        reservation: {
          ...resource,
          state: 'terminal-charged',
          usageApplied: true,
          appliedUsage: null,
          history: [
            ...resource.history,
            { state: 'terminal-charged', at: NOW, reason: 'terminal-accounting' },
          ],
        },
        usageApplied: true,
        appliedAmount: resource.amount,
      }),
    },
  };
}

function admissionInput(sessionId: string): BriefAdmissionInput {
  const brief = ref('# Original brief\n', 'tasks.md');
  return {
    sessionId,
    origin: { mode: 'quick', entry: 'initial' },
    continuation: { version: 1, kind: 'quick-start', entry: 'initial' },
    activeBrief: brief,
    report: {
      briefHash: brief.hash,
      report: ref('{"errorCount":1}', 'brief-quality.json'),
      ruleVersion: 'brief-quality-v1',
      issues: [
        {
          code: 'empty_task_list',
          severity: 'error',
          taskId: null,
          message: 'The planner produced no Task Briefs.',
        },
      ],
      errorCount: 1,
    },
    qualityPolicyVersion: 'brief-quality-v1',
  };
}

function stateView(state: WorkflowState): BriefRecoveryStateView {
  return {
    stateVersion: state.stateVersion,
    stateRevision: state.stateRevision ?? 0,
    stateFence: state.stateFence ?? { token: 0, ownerId: 'rpc-test-owner' },
    phase: state.phase,
    briefRecovery: state.briefRecovery ?? null,
  };
}

function commandFor(
  projection: BriefRecoveryProjectionV1,
  action: Exclude<BriefReviewCommandAction, 'status' | 'comment' | 'import'>,
  operationId: string,
  extra: Record<string, unknown> = {},
): BriefReviewCommand {
  if (projection.epochId === null || projection.activeBrief === null) {
    throw new Error('A recovery command requires an active recovery epoch and Brief');
  }
  return BriefReviewCommandSchema.parse({
    version: 1,
    sessionId: projection.sessionId,
    epochId: projection.epochId,
    operationId,
    expectedBriefRevision: projection.activeBrief.revision,
    expectedReportRevision: projection.matchingReport?.report.revision ?? null,
    intentHash: hash(`${operationId}:${action}`),
    base: projection.activeBrief,
    action,
    ...extra,
  });
}

function canonicalRecoveryCommand(
  command: Exclude<BriefReviewCommand, { action: 'status' }>,
): Exclude<BriefRecoveryCommand, { action: 'status' }> | null {
  if (command.action === 'comment' || command.action === 'import') return null;
  const shared = {
    version: command.version,
    sessionId: command.sessionId,
    epochId: command.epochId,
    operationId: command.operationId,
    base: command.base,
    intentHash: command.intentHash,
  };
  const candidate: Record<string, unknown> = { ...shared, action: command.action };
  if (command.action === 'retry') {
    candidate.diagnosticFingerprint = command.diagnosticFingerprint;
    candidate.frozenInputIds = command.frozenInputIds;
  } else if (command.action === 'edit') {
    candidate.briefText = command.briefText;
    candidate.newInputId = command.newInputId;
  } else if (command.action === 'reject') {
    candidate.userIntentId = command.userIntentId;
  } else if (command.action === 'resolve-unresolved') {
    candidate.heldInputIds = command.heldInputIds;
    candidate.resolution = command.resolution;
  }
  const parsed = BriefRecoveryCommandSchema.safeParse(candidate);
  return parsed.success && parsed.data.action !== 'status' ? parsed.data : null;
}

async function createScenario(
  options: { provider: ProviderMode } = { provider: 'completed' },
): Promise<Scenario> {
  const projectDir = createTempDir('rpc-brief-recovery');
  tempDirs.push(projectDir);
  const sessionId = 'rpc-brief-recovery-session';
  const refForSession = { projectDir, sessionId };
  ensureSessionDir(projectDir, sessionId);

  let persistedState = createInitialState('rpc recovery') as WorkflowState;
  saveState(refForSession, persistedState);
  let currentAuthority = authority(sessionId);
  let providerCalls = 0;
  let implementationCalls = 0;
  let nextEvidenceRevision = 1;
  const implementedOperations = new Set<string>();

  const provider = {
    async dispatch(input: RecoveryProviderRequest): Promise<RecoveryProviderResult> {
      providerCalls += 1;
      if (options.provider === 'ambiguous') {
        return {
          kind: 'ambiguous-failure',
          requestId: input.requestId,
          dispatchPossibility: 'possible',
          remoteObservation: 'unknown',
          text: null,
          providerCode: 'connection-lost',
          usage: null,
        };
      }
      return {
        kind: 'completed',
        requestId: input.requestId,
        dispatchPossibility: 'possible',
        remoteObservation: 'confirmed-final',
        text: '# Corrected brief\n',
        providerCode: null,
        usage: null,
      };
    },
  };

  const deps: BriefRecoveryControllerDeps = {
    provider,
    ...budgetDependencies(),
    evaluateQuality: (value) =>
      typeof value === 'string' && value.includes('intentionally blocked')
        ? [
            {
              code: 'missing_scope',
              severity: 'error' as const,
              taskId: null,
              message: 'The edited Brief remains intentionally blocked.',
            },
          ]
        : [],
    readRetryContext: ({ recovery }) => ({
      prompt: `Repair the Brief at ${recovery.activeBrief.path}.`,
      projectDir,
      currentKnownSpend: 0,
      maxBudget: 1,
    }),
    now: () => NOW,
    nextId: (() => {
      let id = 0;
      return () => `rpc-id-${++id}`;
    })(),
    commit: (input: BriefOwnerCommitInput): BriefOwnerCommitResult => {
      const persisted = stateView(persistedState);
      const current: BriefRecoveryStateView = {
        ...persisted,
        stateRevision: currentAuthority.stateRevision,
        stateFence: { token: currentAuthority.fence, ownerId: currentAuthority.ownerId },
      };
      const currentDigest = currentAuthority.stateDigest ?? hash(JSON.stringify(persistedState));
      if (
        input.expected.stateRevision.rawSha256 !== currentDigest ||
        input.expected.authorityRevision !== current.stateRevision ||
        input.expected.fence !== String(current.stateFence.token) ||
        (current.briefRecovery !== null && current.briefRecovery.epochId !== input.expected.epochId)
      ) {
        return {
          kind: 'conflict',
          stateRevision: null,
          authorityRevision: null,
          recovery: null,
          generation: null,
          permit: null,
        };
      }
      const evidencePayload = JSON.stringify(input.evidence.payload) ?? '';
      const evidence = {
        revision: 1 as const,
        hash: hash(evidencePayload),
        path: `brief-recovery/evidence-${nextEvidenceRevision}.json`,
      };
      nextEvidenceRevision += 1;
      const patch = input.projectNext({
        current,
        evidenceRef: evidence,
        eventId: input.event.eventId,
      });
      const next = BriefRecoveryStateViewSchema.parse(patch.recovery);
      const audit = isRecord(input.evidence.payload) ? input.evidence.payload : null;
      if (audit?.kind === 'brief-edited' && typeof audit.briefText === 'string') {
        writeFileSync(join(sessionDir(projectDir, sessionId), 'tasks.md'), audit.briefText);
        const report = isRecord(audit.report) ? audit.report : null;
        if (report !== null) {
          const issues = Array.isArray(report.issues) ? report.issues : [];
          const passed = !issues.some((issue) => isRecord(issue) && issue.severity === 'error');
          writeFileSync(
            join(sessionDir(projectDir, sessionId), 'brief-quality.json'),
            JSON.stringify(
              {
                version: 1,
                passed,
                score: passed ? 1 : 0,
                issues,
                ...(typeof report.briefHash === 'string' ? { briefHash: report.briefHash } : {}),
                ruleVersion: 'brief-quality-v1',
              },
              null,
              2,
            ),
          );
        }
      }
      persistedState = {
        ...persistedState,
        phase: PhaseSchema.parse(next.phase),
        stateVersion: 4,
        stateRevision: next.stateRevision,
        stateFence: next.stateFence,
        briefRecovery: next.briefRecovery,
        authorityRevision: patch.authorityRevision,
        generation: patch.generation,
        permit: patch.permit,
      };
      saveState(refForSession, persistedState);
      currentAuthority = {
        ...currentAuthority,
        stateRevision: next.stateRevision,
        stateDigest: hash(JSON.stringify(persistedState)),
      };
      const stateRevision: ConfigRevision = {
        rawSha256: currentAuthority.stateDigest,
        fileIdentity: { dev: 0n, ino: 0n, size: 0n, mtimeNs: 0n },
      };
      return {
        kind: 'committed',
        stateRevision,
        authorityRevision: patch.authorityRevision,
        recovery: next,
        generation: patch.generation,
        permit: patch.permit,
      };
    },
  };
  const controller = createBriefRecoveryController(deps);
  const admission = await controller.enterBriefAdmission(
    admissionInput(sessionId),
    currentAuthority,
  );

  let commandTail: Promise<void> = Promise.resolve();
  const resultCache = new Map<string, RecoveryResultV1>();

  const attach = (label: string, observerController = controller): RpcClient => {
    const input = new PassThrough();
    const chunks: string[] = [];
    const output = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(String(chunk));
        callback();
      },
    });
    const writer = createResponseWriter({
      stream: output,
      onClose: () => undefined,
      getPersistTranscript: () => true,
    });
    const reader = createCommandReader({
      stream: input,
      onCommand: (command) => {
        commandTail = commandTail.then(
          async () => {
            if (command.type === 'status') {
              const state = loadState(refForSession) ?? persistedState;
              const projection = observerController.inspectBriefRecovery({
                sessionId,
                state: stateView(state),
                now: NOW,
              });
              writer.status({ sessionId, phase: state.phase, briefRecovery: projection });
              return;
            }
            if (command.type !== 'brief_review') {
              writer.error(`Unsupported recovery command from ${label}.`);
              return;
            }
            if (command.command.action === 'status') {
              const state = loadState(refForSession) ?? persistedState;
              const projection = observerController.inspectBriefRecovery({
                sessionId,
                state: stateView(state),
                now: NOW,
              });
              writer.status({ sessionId, phase: state.phase, briefRecovery: projection });
              return;
            }
            const recoveryCommand = canonicalRecoveryCommand(command.command);
            if (recoveryCommand === null) {
              writer.error('The RPC command is not a recovery action.');
              return;
            }
            const cached = resultCache.get(recoveryCommand.operationId);
            const result =
              cached ??
              (await observerController.dispatchBriefAction(recoveryCommand, currentAuthority));
            if (cached === undefined) resultCache.set(recoveryCommand.operationId, result);
            writer.ack('brief_review', {
              id: command.id ?? null,
              operationId: command.operationId ?? recoveryCommand.operationId,
              action: command.command.action,
              result,
            });
            if (
              result.kind === 'ready' &&
              !implementedOperations.has(recoveryCommand.operationId)
            ) {
              implementedOperations.add(recoveryCommand.operationId);
              implementationCalls += 1;
            }
          },
          async () => undefined,
        );
      },
      onError: (message) => writer.error(message),
      requireCurrentV4: false,
      operationDedupe: createRpcOperationDeduper(),
    });
    const client: RpcClient = {
      chunks,
      send: (command) => input.write(`${JSON.stringify(command)}\n`),
      close: () => {
        reader.close();
        input.end();
      },
    };
    clients.push(client);
    return client;
  };

  return {
    projectDir,
    sessionId,
    controller,
    admission,
    providerCalls: () => providerCalls,
    implementationCalls: () => implementationCalls,
    currentAuthority: () => currentAuthority,
    currentState: () => persistedState,
    attach,
  };
}

afterEach(() => {
  for (const client of clients.splice(0)) client.close();
  for (const directory of tempDirs.splice(0)) cleanupTempDir(directory);
});

describe('RPC Brief recovery', () => {
  it('returns a call-free status and refuses approve while the persisted contract is blocked', async () => {
    const scenario = await createScenario();
    const client = scenario.attach('rpc');

    client.send({ type: 'status' });
    const status = await waitForLine(
      client,
      (line) => line.type === 'status' && isRecord(line.data) && 'briefRecovery' in line.data,
    );
    const statusData = status.data;
    expect(statusData?.briefRecovery).toMatchObject({
      status: 'blocked',
      allowedActions: expect.arrayContaining(['retry', 'edit', 'reject']),
    });
    expect(scenario.providerCalls()).toBe(0);

    const before = loadState({ projectDir: scenario.projectDir, sessionId: scenario.sessionId });
    if (before === null || before.briefRecovery === null || before.briefRecovery === undefined) {
      throw new Error('blocked recovery state was not persisted');
    }
    const projection = BriefRecoveryProjectionV1Schema.parse(statusData?.briefRecovery);
    const approve = commandFor(projection, 'approve', 'approve-blocked');
    client.send({
      type: 'brief_review',
      id: 'rpc-approve-blocked',
      operationId: 'approve-blocked',
      command: approve,
    });
    const response = await waitForLine(
      client,
      (line) =>
        line.type === 'ack' &&
        line.command === 'brief_review' &&
        isRecord(line.data) &&
        line.data.action === 'approve',
    );
    const result = isRecord(response.data) ? response.data.result : null;
    expect(result).toMatchObject({ kind: 'conflict', code: 'brief_contract_blocked' });
    expect(scenario.providerCalls()).toBe(0);
    expect(scenario.implementationCalls()).toBe(0);
    expect(
      loadState({ projectDir: scenario.projectDir, sessionId: scenario.sessionId })?.briefRecovery,
    ).toEqual(before.briefRecovery);
  });

  it('deduplicates concurrent TUI/RPC retry intents to one receipt, result, and planner call', async () => {
    const scenario = await createScenario();
    const tui = scenario.attach('tui');
    const rpc = scenario.attach('rpc');
    const projection = scenario.controller.inspectBriefRecovery({
      sessionId: scenario.sessionId,
      state: stateView(scenario.currentState()),
      now: NOW,
    });
    const retry = commandFor(projection, 'retry', 'retry-shared', {
      diagnosticFingerprint: hash('empty-task-list'),
      frozenInputIds: [],
    });
    const tuiRequest = {
      type: 'brief_review' as const,
      id: 'tui-retry',
      operationId: 'retry-shared',
      command: retry,
    };
    const rpcRequest = { ...tuiRequest, id: 'rpc-retry' };
    tui.send(tuiRequest);
    rpc.send(rpcRequest);

    const tuiResult = await waitForLine(
      tui,
      (line) => line.type === 'ack' && line.command === 'brief_review',
    );
    const rpcResult = await waitForLine(
      rpc,
      (line) => line.type === 'ack' && line.command === 'brief_review',
    );
    const tuiData = tuiResult.data;
    const rpcData = rpcResult.data;
    expect(tuiData?.operationId).toBe('retry-shared');
    expect(rpcData?.operationId).toBe('retry-shared');
    expect(tuiData?.result).toEqual(rpcData?.result);
    expect(tuiData?.result).toMatchObject({
      kind: 'ready',
      projection: { status: 'ready' },
    });
    expect(scenario.providerCalls()).toBe(1);
    expect(scenario.implementationCalls()).toBe(1);
  });

  it('persists an RPC edit verbatim, keeps it blocked until rechecked, and records reject', async () => {
    const scenario = await createScenario();
    const client = scenario.attach('rpc');
    const beforeProjection = scenario.controller.inspectBriefRecovery({
      sessionId: scenario.sessionId,
      state: stateView(scenario.currentState()),
      now: NOW,
    });
    const editedText = '# User-authored replacement\n\nThis remains intentionally blocked.\n';
    const edit = commandFor(beforeProjection, 'edit', 'edit-1', {
      briefText: editedText,
      newInputId: 'input-edit-1',
    });
    client.send({ type: 'brief_review', id: 'rpc-edit', operationId: 'edit-1', command: edit });
    const editResponse = await waitForLine(
      client,
      (line) => line.type === 'ack' && line.command === 'brief_review',
    );
    expect(editResponse.data?.result).toMatchObject({
      kind: 'blocked',
      projection: { status: 'blocked' },
    });
    expect(
      readFileSync(join(sessionDir(scenario.projectDir, scenario.sessionId), 'tasks.md'), 'utf8'),
    ).toBe(editedText);
    const afterEdit = loadState({
      projectDir: scenario.projectDir,
      sessionId: scenario.sessionId,
    });
    expect(afterEdit?.briefRecovery).toMatchObject({ status: 'blocked' });
    if (afterEdit?.briefRecovery === null || afterEdit?.briefRecovery === undefined) {
      throw new Error('edited recovery state was not persisted');
    }
    expect(afterEdit.briefRecovery.activeBrief?.hash).toBe(hash(editedText));
    expect(scenario.providerCalls()).toBe(0);
    expect(scenario.implementationCalls()).toBe(0);

    const editedProjection = scenario.controller.inspectBriefRecovery({
      sessionId: scenario.sessionId,
      state: stateView(afterEdit),
      now: NOW,
    });
    const reject = commandFor(editedProjection, 'reject', 'reject-1', {
      userIntentId: 'user-reject-1',
    });
    client.send({
      type: 'brief_review',
      id: 'rpc-reject',
      operationId: 'reject-1',
      command: reject,
    });
    const rejectResponse = await waitForLine(
      client,
      (line) =>
        line.type === 'ack' &&
        line.command === 'brief_review' &&
        isRecord(line.data) &&
        line.data.action === 'reject',
    );
    expect(rejectResponse.data?.result).toMatchObject({
      kind: 'rejected',
      projection: { status: 'rejected' },
    });
    expect(scenario.currentState().phase).toBe('idle');
    expect(scenario.currentState().briefRecovery?.status).toBe('rejected');
    expect(scenario.providerCalls()).toBe(0);
    expect(scenario.implementationCalls()).toBe(0);
  });

  it('rebuilds the same projection after disconnect/reconnect without a planner call', async () => {
    const scenario = await createScenario();
    const first = scenario.attach('rpc-1');
    first.send({ type: 'status' });
    const initial = await waitForLine(
      first,
      (line) => line.type === 'status' && isRecord(line.data) && 'briefRecovery' in line.data,
    );
    const projection = initial.data?.briefRecovery;
    first.close();

    const second = scenario.attach('rpc-2');
    second.send({ type: 'status' });
    const resumed = await waitForLine(
      second,
      (line) => line.type === 'status' && isRecord(line.data) && 'briefRecovery' in line.data,
    );
    expect(resumed.data?.briefRecovery).toEqual(projection);
    expect(scenario.providerCalls()).toBe(0);
  });

  it('keeps an ambiguous planner attempt unresolved and durable across crash/resume', async () => {
    const scenario = await createScenario({ provider: 'ambiguous' });
    const client = scenario.attach('rpc-before-crash');
    const projection = scenario.controller.inspectBriefRecovery({
      sessionId: scenario.sessionId,
      state: stateView(scenario.currentState()),
      now: NOW,
    });
    const retry = commandFor(projection, 'retry', 'retry-ambiguous', {
      diagnosticFingerprint: hash('ambiguous'),
      frozenInputIds: [],
    });
    client.send({
      type: 'brief_review',
      id: 'rpc-ambiguous',
      operationId: 'retry-ambiguous',
      command: retry,
    });
    const response = await waitForLine(
      client,
      (line) => line.type === 'ack' && line.command === 'brief_review',
    );
    expect(response.data?.result).toMatchObject({
      kind: 'unresolved',
      projection: { status: 'unresolved', remoteUsage: 'REMOTE USAGE UNKNOWN' },
    });
    expect(scenario.providerCalls()).toBe(1);
    client.close();

    const persisted = loadState({
      projectDir: scenario.projectDir,
      sessionId: scenario.sessionId,
    });
    expect(persisted?.briefRecovery).toMatchObject({ status: 'unresolved' });
    const observerCalls = vi.fn();
    const observerController = createBriefRecoveryController({
      ...budgetDependencies(),
      provider: {
        dispatch: async () => {
          observerCalls();
          throw new Error('status must not dispatch');
        },
      },
      evaluateQuality: () => {
        throw new Error('observer quality is unavailable');
      },
      commit: () => {
        throw new Error('observer commit is unavailable');
      },
    });
    const observer = scenario.attach('rpc-after-resume', observerController);
    observer.send({ type: 'status' });
    const resumed = await waitForLine(
      observer,
      (line) => line.type === 'status' && isRecord(line.data) && 'briefRecovery' in line.data,
    );
    expect(resumed.data?.briefRecovery).toMatchObject({
      status: 'unresolved',
      remoteUsage: 'REMOTE USAGE UNKNOWN',
    });
    expect(observerCalls).not.toHaveBeenCalled();
    expect(scenario.providerCalls()).toBe(1);
  });
});
