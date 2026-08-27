import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createInitialState } from '../../../src/core/state/machine.js';
import type { BriefRecoveryControllerDeps } from '../../../src/core/schemas/brief-owner.js';
import type {
  BudgetReservation,
  RecoveryUsage,
} from '../../../src/core/schemas/brief-recovery/budget.js';
import {
  type BriefRecoveryProjectionV1,
  BriefRecoveryStateViewSchema,
} from '../../../src/core/schemas/brief-recovery/document.js';
import type {
  BriefAdmissionInput,
  BriefRecoveryCommand,
  BriefRecoveryController,
  BriefRecoveryMigrationInput,
  StateAuthorityReceipt,
} from '../../../src/core/schemas/brief-recovery.js';
import type { EvidenceRef } from '../../../src/core/schemas/brief-recovery/primitives.js';
import type {
  RecoveryProviderRequest,
  RecoveryProviderResult,
} from '../../../src/core/schemas/brief-recovery/provider-call.js';
import { WorkflowStateSchema, type WorkflowState } from '../../../src/core/schemas/workflow.js';
import {
  createBriefRecoveryController,
  projectBriefRecovery,
} from '../../../src/engine/orchestrator/planning/brief-recovery-controller.js';
import type {
  BriefOwnerCommitInput,
  BriefOwnerCommitResult,
  ConfigRevision,
} from '../../../src/core/schemas/brief-owner.js';
import {
  acceptRecoveryOperation,
  createBriefRecoveryState,
  interruptRecoveryOperation,
  settleRecoveryOperation,
  startRecoveryOperation,
  supersedeRecoveryOperation,
} from '../../../src/engine/orchestrator/planning/brief-recovery.js';

const SESSION_ID = 'brief-recovery-matrix';
const OWNER_ID = 'matrix-owner';
const FENCE = 7;
const NOW = '2026-08-13T00:00:00.000Z';

type Mode = 'standard' | 'speckit' | 'instant' | 'quick';
type Entry = 'initial' | 'rewind' | 'regenerated-plan' | 'auto-split';
type ProviderPlan = (
  input: RecoveryProviderRequest,
) => RecoveryProviderResult | Promise<RecoveryProviderResult>;

type MutationRecord = {
  state: ReturnType<typeof BriefRecoveryStateViewSchema.parse>;
  authority: StateAuthorityReceipt;
  evidence: EvidenceRef;
};

type NormalRecovery = Extract<
  NonNullable<MutationRecord['state']['briefRecovery']>,
  { attempts: unknown }
>;

type AccountingCall = {
  kind: 'estimate' | 'reserve' | 'reconcile' | 'terminal-charge';
  key?: BudgetReservation['accountingKey'];
  usageApplied?: boolean;
  state?: BudgetReservation['state'];
};

type HarnessOptions = {
  providerPlan?: ProviderPlan;
  qualityIssues?: readonly {
    code: string;
    severity: 'error' | 'warning';
    taskId: string | null;
    message: string;
  }[];
  stableEvidence?: boolean;
  failDispatchFence?: boolean;
  budgetRefused?: boolean;
};

type Harness = {
  controller: BriefRecoveryController;
  providerCalls: RecoveryProviderRequest[];
  mutations: MutationRecord[];
  accounting: AccountingCall[];
  evidence: Array<{ ref: EvidenceRef; value: unknown }>;
  published: BriefRecoveryProjectionV1[];
  authority(revision?: number): StateAuthorityReceipt;
  lastState(): MutationRecord['state'] | null;
};

function sha(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function authority(revision = 0, sessionId = SESSION_ID): StateAuthorityReceipt {
  return {
    kind: 'usable',
    sessionId,
    ownerId: OWNER_ID,
    pid: 1,
    processStart: 'matrix-process',
    runId: 'matrix-run',
    acquisitionId: 'matrix-acquisition',
    fence: FENCE,
    stateRevision: revision,
    stateDigest: sha(`${sessionId}:${revision}`),
  };
}

function evidence(hash: string, path: string, revision = 1): EvidenceRef {
  return { revision, hash, path };
}

function reservation(
  key: BudgetReservation['accountingKey'],
  state: BudgetReservation['state'] = 'reserved',
): BudgetReservation {
  return {
    accountingKey: key,
    amount: 0.1,
    bookedAmount: 0.1,
    state,
    usageApplied: state === 'terminal-charged',
    appliedUsage: null,
    history: [
      {
        state: state === 'terminal-charged' ? 'reserved' : state,
        at: NOW,
        reason: 'accepted',
      },
    ],
  };
}

function usage(): RecoveryUsage {
  return { inputTokens: 12, outputTokens: 8, totalTokens: 20, estimated: false };
}

function makeAdmission(
  mode: Mode,
  entry: Entry,
  issues: readonly {
    code: string;
    severity: 'error' | 'warning';
    taskId: string | null;
    message: string;
  }[] = [],
  sessionId = SESSION_ID,
): BriefAdmissionInput {
  const suffix = `${mode}-${entry}`;
  const activeBrief = evidence(`brief-${suffix}`, `tasks-${suffix}.md`);
  return {
    sessionId,
    origin: { mode, entry },
    continuation: continuationFor(mode, entry),
    activeBrief,
    report: {
      briefHash: activeBrief.hash,
      report: evidence(`report-${suffix}`, `brief-quality-${suffix}.json`),
      ruleVersion: 'brief-quality-v1',
      issues,
      errorCount: issues.filter((issue) => issue.severity === 'error').length,
    },
    qualityPolicyVersion: 'brief-quality-v1',
  };
}

function continuationFor(mode: Mode, entry: Entry): BriefAdmissionInput['continuation'] {
  if (mode === 'standard' || mode === 'speckit') {
    return { version: 1, kind: 'approval', mode, entry };
  }
  if (entry === 'auto-split') {
    throw new Error(`${mode} does not support auto-split continuation`);
  }
  return mode === 'instant'
    ? { version: 1, kind: 'instant-start', entry }
    : { version: 1, kind: 'quick-start', entry };
}

function normalRecovery(state: MutationRecord['state'] | null): NormalRecovery | null {
  const recovery = state?.briefRecovery;
  return recovery !== null && recovery !== undefined && 'attempts' in recovery ? recovery : null;
}

function qualityIssue(code = 'missing_scope') {
  return { code, severity: 'error' as const, taskId: 'T001', message: `${code} is required` };
}

function makeHarness(options: HarnessOptions = {}): Harness {
  const providerCalls: RecoveryProviderRequest[] = [];
  const mutations: MutationRecord[] = [];
  const accounting: AccountingCall[] = [];
  const evidenceWrites: Array<{ ref: EvidenceRef; value: unknown }> = [];
  const published: BriefRecoveryProjectionV1[] = [];
  let currentView: MutationRecord['state'] = {
    stateVersion: 4,
    stateRevision: 0,
    stateFence: { token: FENCE, ownerId: OWNER_ID },
    phase: 'reviewing-briefs',
    briefRecovery: null,
  };
  let currentDigest = authority().stateDigest;
  let id = 0;
  let evidenceRevision = 0;
  const providerPlan =
    options.providerPlan ??
    ((input: RecoveryProviderRequest) => ({
      kind: 'completed' as const,
      requestId: input.requestId,
      dispatchPossibility: 'possible' as const,
      remoteObservation: 'confirmed-final' as const,
      text: 'corrected brief',
      providerCode: null,
      usage: usage(),
    }));
  const qualityIssues = options.qualityIssues ?? [];

  const deps: BriefRecoveryControllerDeps = {
    provider: {
      async dispatch(input) {
        providerCalls.push(input);
        return providerPlan(input);
      },
    },
    budget: {
      estimate: () => {
        accounting.push({ kind: 'estimate' });
        return {
          kind: 'finite',
          budgetUnit: 'usd',
          inputTokens: 12,
          outputTokens: 8,
          amount: 0.1,
          pricingIdentity: 'matrix-pricing',
        };
      },
      reserve: ({ accountingKey }) => {
        accounting.push({ kind: 'reserve', key: accountingKey, state: 'reserved' });
        if (options.budgetRefused) {
          return {
            kind: 'refused' as const,
            code: 'brief_budget_exhausted' as const,
            reason: 'matrix budget exhausted',
          };
        }
        return { kind: 'reserved' as const, reservation: reservation(accountingKey) };
      },
      reconcile: ({ accountingKey, reservation: current, usage: applied, remoteObservation }) => {
        const nextState =
          remoteObservation === 'not-dispatched'
            ? 'released'
            : applied !== null
              ? 'reconciled'
              : 'held';
        const next: BudgetReservation = {
          ...current,
          state: nextState,
          usageApplied: applied !== null,
          appliedUsage: applied,
          history: [
            ...current.history,
            {
              state: nextState,
              at: NOW,
              reason:
                remoteObservation === 'unknown'
                  ? 'unresolved'
                  : remoteObservation === 'not-dispatched'
                    ? 'interrupted'
                    : 'confirmed-final',
            },
          ],
        };
        accounting.push({
          kind: 'reconcile',
          key: accountingKey,
          state: nextState,
          usageApplied: next.usageApplied,
        });
        return {
          reservation: next,
          usageApplied: next.usageApplied,
          appliedAmount: applied === null ? 0 : 0.1,
        };
      },
      terminalCharge: ({ accountingKey, reservation: current }) => {
        const next: BudgetReservation = {
          ...current,
          state: 'terminal-charged',
          usageApplied: true,
          appliedUsage: null,
          history: [
            ...current.history,
            { state: 'terminal-charged', at: NOW, reason: 'terminal-accounting' },
          ],
        };
        accounting.push({
          kind: 'terminal-charge',
          key: accountingKey,
          state: next.state,
          usageApplied: true,
        });
        return { reservation: next, usageApplied: true, appliedAmount: current.amount };
      },
    },
    evaluateQuality: () => [...qualityIssues],
    readRetryContext: ({ recovery }) => ({
      prompt: `Repair the Brief at ${recovery.activeBrief.path}.`,
      projectDir: '/tmp/brief-recovery-matrix',
      currentKnownSpend: 0,
      maxBudget: 1,
    }),
    commit: (input: BriefOwnerCommitInput): BriefOwnerCommitResult => {
      if (currentView.stateRevision === 0 && currentView.briefRecovery === null) {
        currentView = {
          ...currentView,
          stateFence: {
            ...currentView.stateFence,
            token: Number(input.expected.fence),
          },
        };
      }
      if (
        input.expected.stateRevision.rawSha256 !== currentDigest ||
        input.expected.authorityRevision !== currentView.stateRevision ||
        input.expected.fence !== String(currentView.stateFence.token) ||
        (currentView.briefRecovery !== null &&
          currentView.briefRecovery.epochId !== input.expected.epochId)
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
      const record =
        typeof input.evidence.payload === 'object' && input.evidence.payload !== null
          ? (input.evidence.payload as Record<string, unknown>)
          : {};
      const kind = typeof record.kind === 'string' ? record.kind : 'audit';
      const sequence = ++evidenceRevision;
      const content = options.stableEvidence
        ? `${kind}:${JSON.stringify(record)}`
        : `${kind}:${sequence}:${JSON.stringify(record)}`;
      const evidenceRef = {
        revision: 1 as const,
        hash: sha(content),
        path: `brief-recovery-matrix/${kind}-${sequence}.json`,
      };
      const patch = input.projectNext({
        current: currentView,
        evidenceRef,
        eventId: input.event.eventId,
      });
      const nextState = BriefRecoveryStateViewSchema.parse(patch.recovery);
      const recovery = nextState.briefRecovery;
      const active =
        recovery !== null && 'attempts' in recovery && recovery.activeOperationId !== null
          ? recovery.attempts[recovery.activeOperationId]
          : null;
      if (options.failDispatchFence && active?.status === 'started') {
        throw new Error('matrix dispatch fence failure');
      }
      currentView = nextState;
      currentDigest = authority(nextState.stateRevision).stateDigest;
      const stateRevision: ConfigRevision = {
        rawSha256: currentDigest,
        fileIdentity: { dev: 0n, ino: 0n, size: 0n, mtimeNs: 0n },
      };
      evidenceWrites.push({ ref: evidenceRef, value: input.evidence.payload });
      mutations.push({
        state: nextState,
        authority: authority(nextState.stateRevision),
        evidence: evidenceRef,
      });
      published.push(projectBriefRecovery({ sessionId: SESSION_ID, state: nextState, now: NOW }));
      return {
        kind: 'committed',
        stateRevision,
        authorityRevision: patch.authorityRevision,
        recovery: nextState,
        generation: patch.generation,
        permit: patch.permit,
      };
    },
    now: () => NOW,
    nextId: () => `matrix-${++id}`,
  };
  const controller = createBriefRecoveryController(deps);
  return {
    controller,
    providerCalls,
    mutations,
    accounting,
    evidence: evidenceWrites,
    published,
    authority: (revision = 0) => authority(revision),
    lastState: () => mutations.at(-1)?.state ?? null,
  };
}

function modeEntries(): Array<[Mode, Entry]> {
  const rows: Array<[Mode, Entry]> = [];
  for (const mode of ['standard', 'speckit'] as const) {
    for (const entry of ['initial', 'rewind', 'regenerated-plan', 'auto-split'] as const)
      rows.push([mode, entry]);
  }
  for (const mode of ['instant', 'quick'] as const) {
    for (const entry of ['initial', 'rewind', 'regenerated-plan'] as const)
      rows.push([mode, entry]);
  }
  return rows;
}

function retryCommand(
  admission: BriefAdmissionInput,
  epochId: string,
  operationId: string,
  base = admission.activeBrief,
  frozenInputIds: readonly string[] = [],
): Extract<BriefRecoveryCommand, { action: 'retry' }> {
  return {
    version: 1,
    sessionId: admission.sessionId,
    epochId,
    operationId,
    base,
    intentHash: sha(`retry:${operationId}:${base.hash}`),
    diagnosticFingerprint: sha(`diagnostic:${base.hash}`),
    action: 'retry',
    frozenInputIds,
  };
}

function editCommand(
  admission: BriefAdmissionInput,
  epochId: string,
  operationId: string,
  text = 'edited Brief',
): Extract<BriefRecoveryCommand, { action: 'edit' }> {
  return {
    version: 1,
    sessionId: admission.sessionId,
    epochId,
    operationId,
    base: admission.activeBrief,
    intentHash: sha(`edit:${operationId}`),
    action: 'edit',
    briefText: text,
    newInputId: `${operationId}-input`,
  };
}

function rejectCommand(
  admission: BriefAdmissionInput,
  epochId: string,
  operationId: string,
): Extract<BriefRecoveryCommand, { action: 'reject' }> {
  return {
    version: 1,
    sessionId: admission.sessionId,
    epochId,
    operationId,
    base: admission.activeBrief,
    intentHash: sha(`reject:${operationId}`),
    action: 'reject',
    userIntentId: `${operationId}-user-intent`,
  };
}

function workflowState(
  view: MutationRecord['state'],
  phase: 'reviewing-briefs' | 'idle' = 'reviewing-briefs',
): WorkflowState {
  const initial = createInitialState('brief-recovery-matrix');
  return WorkflowStateSchema.parse({
    ...initial,
    stateVersion: 4,
    stateRevision: view.stateRevision,
    stateFence: view.stateFence,
    phase,
    briefRecovery: view.briefRecovery,
  });
}

function legacyState(
  mode: Mode = 'standard',
  phase: WorkflowState['phase'] = 'reviewing-briefs',
  messageQueue: WorkflowState['messageQueue'] = [],
): WorkflowState {
  return {
    ...createInitialState('legacy-matrix'),
    stateVersion: 3,
    phase,
    mode,
    messageQueue,
  };
}

function legacyArtifacts(
  brief = '# Brief\n',
  report: unknown = { version: 1, passed: true, score: 1, issues: [] },
) {
  return { brief, report: JSON.stringify(report), queuedInputs: [] };
}

function authorityForRaw(raw: unknown): StateAuthorityReceipt {
  const record = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const fence =
    typeof record.stateFence === 'object' && record.stateFence !== null
      ? (record.stateFence as Record<string, unknown>)
      : {};
  const next = authority(typeof record.stateRevision === 'number' ? record.stateRevision : 0);
  return {
    ...next,
    fence: typeof fence.token === 'number' ? fence.token : next.fence,
    ownerId: typeof fence.ownerId === 'string' ? fence.ownerId : next.ownerId,
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100 && !predicate(); attempt += 1) await Promise.resolve();
  if (!predicate()) throw new Error('matrix operation did not reach its fenced point');
}

describe('Brief recovery mode and entry matrix', () => {
  it.each(modeEntries())(
    '%s/%s preserves origin, continuation, allowance, persisted identity, and provider accounting',
    async (mode, entry) => {
      const automatic =
        ((mode === 'standard' || mode === 'speckit') && entry !== 'auto-split') ||
        (mode === 'instant' && entry !== 'auto-split');
      const issueCode = mode === 'instant' ? 'empty_task_list' : 'missing_scope';
      const harness = makeHarness();
      const input = makeAdmission(mode, entry, [qualityIssue(issueCode)]);
      const result = await harness.controller.enterBriefAdmission(input, harness.authority());
      const state = harness.lastState();

      expect(state).not.toBeNull();
      expect(state?.stateVersion).toBe(4);
      expect(state?.stateFence).toEqual({ token: FENCE, ownerId: OWNER_ID });
      expect(state?.briefRecovery?.origin).toEqual(input.origin);
      expect(state?.briefRecovery?.continuation).toEqual(input.continuation);
      const recovery = normalRecovery(state);
      expect(recovery).not.toBeNull();
      if (recovery === null) throw new Error('expected a normal Brief recovery state');
      if (automatic) {
        expect(recovery.activeBrief?.path).toContain('planner-candidate');
        expect(recovery.matchingReport?.briefHash).toBe(recovery.activeBrief?.hash);
        expect(recovery.matchingReport?.report.path).toContain('planner-report');
      } else {
        expect(recovery.activeBrief).toEqual(input.activeBrief);
        expect(recovery.matchingReport?.briefHash).toBe(input.activeBrief.hash);
        expect(recovery.matchingReport?.report).toEqual(input.report.report);
      }
      expect(recovery.automaticRepair.policy).toBe(
        mode === 'instant'
          ? 'zero-task-only'
          : mode === 'quick' || entry === 'auto-split'
            ? 'none'
            : 'existing-one-shot',
      );
      expect(harness.providerCalls).toHaveLength(automatic ? 1 : 0);
      expect(harness.accounting.filter((call) => call.kind === 'reserve')).toHaveLength(
        automatic ? 1 : 0,
      );
      expect(result.projection.activeBrief?.hash).toBe(
        automatic ? state?.briefRecovery?.activeBrief?.hash : input.activeBrief.hash,
      );
      expect(result.projection.matchingReport?.briefHash).toBe(result.projection.activeBrief?.hash);
      expect(result.projection.status).toBe(automatic ? 'ready' : 'blocked');
      expect(harness.published.at(-1)).toMatchObject({
        sessionId: SESSION_ID,
        status: result.projection.status,
        activeBrief: result.projection.activeBrief,
        matchingReport: result.projection.matchingReport,
      });

      if (automatic) {
        expect(recovery.automaticRepair).toMatchObject({
          consumed: true,
          operationId: expect.any(String),
        });
        expect(Object.values(recovery.attempts)).toHaveLength(1);
        const receipt = Object.values(recovery.attempts)[0];
        expect(receipt).toMatchObject({
          status: 'settled',
          dispatchPossibility: 'possible',
          outcome: 'ready',
        });
        expect(receipt && 'candidate' in receipt ? receipt.candidate : null).not.toBeNull();
        expect(receipt && 'report' in receipt ? receipt.report : null).not.toBeNull();
        expect(
          harness.accounting.some((call) => call.kind === 'reconcile' && call.usageApplied),
        ).toBe(true);
      } else {
        expect(Object.keys(recovery.attempts)).toHaveLength(0);
        expect(recovery.automaticRepair).toMatchObject({
          eligible: false,
          consumed: false,
          operationId: null,
        });
      }

      const evidenceRevisions = harness.mutations.map((mutation) => mutation.evidence.revision);
      expect(evidenceRevisions).toEqual([...evidenceRevisions].sort((left, right) => left - right));
      expect(new Set(harness.mutations.map((mutation) => mutation.state.stateRevision)).size).toBe(
        harness.mutations.length,
      );
    },
  );
});

describe('Brief recovery controller callers', () => {
  const callers = [
    'inspection',
    'attach',
    'status',
    'RPC',
    'headless observation',
    'initial admission',
    'automatic repair',
    'manual retry',
    'feedback revise',
    'queue drain',
    'saved edit',
    'approve',
    'reject',
    'settlement',
    'migration',
    'private guarded exit',
  ] as const;

  it.each(callers)(
    '%s has one observable controller route and the expected side effects',
    async (caller) => {
      const harness = makeHarness();
      const blocked = makeAdmission('quick', 'initial', [qualityIssue()]);
      const admitted = await harness.controller.enterBriefAdmission(blocked, harness.authority());
      const epochId = admitted.epochId ?? 'missing-epoch';

      switch (caller) {
        case 'inspection':
        case 'attach':
        case 'status':
        case 'RPC':
        case 'headless observation': {
          const projection = harness.controller.inspectBriefRecovery({
            sessionId: SESSION_ID,
            state: harness.lastState() ?? {
              stateVersion: 4,
              stateRevision: 0,
              stateFence: { token: FENCE, ownerId: OWNER_ID },
              phase: 'reviewing-briefs',
              briefRecovery: null,
            },
            now: NOW,
          });
          expect(projection.status).toBe('blocked');
          expect(harness.providerCalls).toHaveLength(0);
          break;
        }
        case 'initial admission':
          expect(admitted.projection.origin).toEqual(blocked.origin);
          expect(admitted.projection.activeBrief).toEqual(blocked.activeBrief);
          break;
        case 'automatic repair': {
          const automaticHarness = makeHarness();
          const automatic = makeAdmission('standard', 'initial', [qualityIssue()]);
          const result = await automaticHarness.controller.enterBriefAdmission(
            automatic,
            automaticHarness.authority(),
          );
          expect(result.kind).toBe('ready');
          expect(automaticHarness.providerCalls).toHaveLength(1);
          expect(
            automaticHarness.accounting.filter((call) => call.kind === 'reserve'),
          ).toHaveLength(1);
          break;
        }
        case 'manual retry': {
          const result = await harness.controller.dispatchBriefAction(
            retryCommand(blocked, epochId, 'manual-retry-1'),
            harness.authority(1),
          );
          expect(result.kind).toBe('ready');
          expect(harness.providerCalls).toHaveLength(1);
          expect(result.projection.latestAttempt?.status).toBe('settled');
          break;
        }
        case 'feedback revise': {
          const queued = await harness.controller.queueBriefInput(
            {
              sessionId: SESSION_ID,
              epochId,
              inputId: 'feedback-1',
              sequence: 1,
              kind: 'feedback',
              source: 'interactive',
              payload: 'Please add a scope section.',
              base: blocked.activeBrief,
              operationId: null,
            },
            harness.authority(1),
          );
          if (queued.kind !== 'accepted') throw new Error(`queue rejected: ${queued.kind}`);
          expect(queued.input.state).toBe('queued');
          expect(queued.input.history.map((event) => event.state)).toEqual(['queued']);
          break;
        }
        case 'queue drain': {
          const first = await harness.controller.queueBriefInput(
            {
              sessionId: SESSION_ID,
              epochId,
              inputId: 'queue-1',
              sequence: 1,
              kind: 'feedback',
              source: 'typed',
              payload: 'queued input',
              base: blocked.activeBrief,
              operationId: null,
            },
            harness.authority(1),
          );
          const replay = await harness.controller.queueBriefInput(
            {
              sessionId: SESSION_ID,
              epochId,
              inputId: 'queue-1',
              sequence: 1,
              kind: 'feedback',
              source: 'typed',
              payload: 'queued input',
              base: blocked.activeBrief,
              operationId: null,
            },
            harness.authority(2),
          );
          if (first.kind !== 'accepted' || replay.kind !== 'replayed') {
            throw new Error(`unexpected queue result: ${first.kind}/${replay.kind}`);
          }
          expect(replay.input.history).toEqual(first.input.history);
          break;
        }
        case 'saved edit': {
          const edited = await harness.controller.dispatchBriefAction(
            editCommand(blocked, epochId, 'saved-edit-1'),
            harness.authority(1),
          );
          expect(edited.kind).toBe('ready');
          expect(edited.projection.status).toBe('ready');
          expect(edited.projection.activeBrief?.hash).not.toBe(blocked.activeBrief.hash);
          expect(harness.providerCalls).toHaveLength(0);
          break;
        }
        case 'approve': {
          const cleanHarness = makeHarness();
          const clean = makeAdmission('quick', 'initial');
          const cleanResult = await cleanHarness.controller.enterBriefAdmission(
            clean,
            cleanHarness.authority(),
          );
          const approved = await cleanHarness.controller.dispatchBriefAction(
            {
              version: 1,
              sessionId: SESSION_ID,
              epochId: cleanResult.epochId ?? 'missing-epoch',
              operationId: 'approve-1',
              base: clean.activeBrief,
              intentHash: sha('approve-1'),
              action: 'approve',
            },
            cleanHarness.authority(1),
          );
          expect(cleanResult.kind).toBe('ready');
          expect(approved.kind).toBe('ready');
          expect(cleanHarness.providerCalls).toHaveLength(0);
          break;
        }
        case 'reject': {
          const rejected = await harness.controller.dispatchBriefAction(
            rejectCommand(blocked, epochId, 'reject-1'),
            harness.authority(1),
          );
          expect(rejected.kind).toBe('rejected');
          expect(rejected.projection.status).toBe('rejected');
          expect(harness.providerCalls).toHaveLength(0);
          expect(harness.accounting.filter((call) => call.kind === 'terminal-charge')).toHaveLength(
            0,
          );
          break;
        }
        case 'settlement': {
          const result = await harness.controller.dispatchBriefAction(
            retryCommand(blocked, epochId, 'settlement-1'),
            harness.authority(1),
          );
          expect(result.kind).toBe('ready');
          expect(harness.accounting.filter((call) => call.kind === 'reconcile')).toHaveLength(1);
          expect(harness.accounting.find((call) => call.kind === 'reconcile')?.usageApplied).toBe(
            true,
          );
          break;
        }
        case 'migration': {
          const migrationHarness = makeHarness();
          const result = await migrationHarness.controller.migrateBriefRecovery(
            {
              sessionId: SESSION_ID,
              rawState: legacyState(),
              artifacts: legacyArtifacts(),
            },
            migrationHarness.authority(),
          );
          expect(result.kind).toBe('migrated');
          expect(result.projection.status).toBe('ready');
          expect(migrationHarness.providerCalls).toHaveLength(0);
          break;
        }
        case 'private guarded exit': {
          const stale = await harness.controller.dispatchBriefAction(
            retryCommand(blocked, epochId, 'stale-guard'),
            harness.authority(0),
          );
          expect(stale.kind).toBe('conflict');
          expect(harness.providerCalls).toHaveLength(0);
          expect(harness.mutations).toHaveLength(1);
          break;
        }
      }
    },
  );
});

describe('Brief recovery hydration and migration matrix', () => {
  const hydrationCases = [
    'v4 blocked',
    'v4 retrying',
    'v4 ready',
    'v4 unresolved',
    'terminal Instant',
    'terminal Quick',
    'storage-blocked',
    'idle rejected archive',
    'other-phase null',
    'v3 clean',
    'v3 invalid',
    'v3 zero-task',
    'v3 missing evidence',
    'v3 malformed evidence',
    'v3 mismatched evidence',
    'future state',
    'future nested state',
  ] as const;

  it.each(hydrationCases)(
    '%s hydrates without a provider or local authority call',
    async (name) => {
      const harness = makeHarness();
      let rawState: unknown;
      let artifacts: BriefRecoveryMigrationInput['artifacts'];
      let expected:
        | 'ready'
        | 'blocked'
        | 'unresolved'
        | 'retrying'
        | 'storage-blocked'
        | 'rejected'
        | 'future-version';

      if (name === 'v4 blocked') {
        const state = makeHarness();
        await state.controller.enterBriefAdmission(
          makeAdmission('quick', 'initial', [qualityIssue()]),
          state.authority(),
        );
        rawState = workflowState(state.lastState()!);
        artifacts = legacyArtifacts();
        expected = 'blocked';
      } else if (name === 'v4 ready') {
        const state = makeHarness();
        await state.controller.enterBriefAdmission(
          makeAdmission('quick', 'initial'),
          state.authority(),
        );
        rawState = workflowState(state.lastState()!);
        artifacts = legacyArtifacts();
        expected = 'ready';
      } else if (name === 'v4 retrying') {
        const providerRelease: { current: ((result: RecoveryProviderResult) => void) | null } = {
          current: null,
        };
        let providerStarted = false;
        const state = makeHarness({
          providerPlan: () => {
            providerStarted = true;
            return new Promise<RecoveryProviderResult>((resolve) => {
              providerRelease.current = resolve;
            });
          },
        });
        const admission = makeAdmission('quick', 'initial', [qualityIssue()]);
        const admitted = await state.controller.enterBriefAdmission(admission, state.authority());
        const dispatch = state.controller.dispatchBriefAction(
          retryCommand(admission, admitted.epochId ?? 'missing', 'hydrate-retrying'),
          state.authority(1),
        );
        await waitFor(() => providerStarted);
        rawState = workflowState(state.lastState()!);
        artifacts = legacyArtifacts();
        expected = 'retrying';
        providerRelease.current?.({
          kind: 'ambiguous-failure',
          requestId: 'matrix-request',
          dispatchPossibility: 'possible',
          remoteObservation: 'unknown',
          text: null,
          providerCode: 'provider-timeout',
          usage: null,
        });
        await dispatch;
      } else if (name === 'v4 unresolved') {
        const state = makeHarness({
          providerPlan: async (input) => ({
            kind: 'ambiguous-failure' as const,
            requestId: input.requestId,
            dispatchPossibility: 'possible' as const,
            remoteObservation: 'unknown' as const,
            text: null,
            providerCode: 'provider-timeout',
            usage: null,
          }),
        });
        const admission = makeAdmission('quick', 'initial', [qualityIssue()]);
        const admitted = await state.controller.enterBriefAdmission(admission, state.authority());
        const retried = await state.controller.dispatchBriefAction(
          retryCommand(admission, admitted.epochId ?? 'missing', 'hydrate-unresolved'),
          state.authority(1),
        );
        rawState = workflowState(state.lastState()!);
        artifacts = legacyArtifacts();
        expected = 'unresolved';
        expect(retried.kind).toBe('unresolved');
      } else if (name === 'terminal Instant' || name === 'terminal Quick') {
        const state = makeHarness();
        const mode = name === 'terminal Instant' ? 'instant' : 'quick';
        const admission = makeAdmission(mode, 'initial', [qualityIssue()]);
        const admitted = await state.controller.enterBriefAdmission(admission, state.authority());
        const rejected = await state.controller.dispatchBriefAction(
          rejectCommand(admission, admitted.epochId ?? 'missing', `terminal-${mode}`),
          state.authority(1),
        );
        rawState = workflowState(state.lastState()!, 'idle');
        artifacts = legacyArtifacts();
        expected = 'rejected';
        expect(rejected.kind).toBe('rejected');
      } else if (name === 'storage-blocked') {
        rawState = legacyState();
        artifacts = legacyArtifacts('# Brief\n', '{bad json');
        expected = 'storage-blocked';
      } else if (name === 'idle rejected archive') {
        const state = makeHarness();
        const admitted = await state.controller.enterBriefAdmission(
          makeAdmission('quick', 'initial', [qualityIssue()]),
          state.authority(),
        );
        const rejected = await state.controller.dispatchBriefAction(
          rejectCommand(
            makeAdmission('quick', 'initial', [qualityIssue()]),
            admitted.epochId ?? 'missing',
            'archive-reject',
          ),
          state.authority(1),
        );
        rawState = workflowState(state.lastState()!, 'idle');
        artifacts = legacyArtifacts();
        expected = 'rejected';
        expect(rejected.kind).toBe('rejected');
      } else if (name === 'other-phase null') {
        rawState = {
          ...createInitialState('other-phase'),
          phase: 'implementing',
          briefRecovery: null,
        };
        artifacts = legacyArtifacts();
        expected = 'storage-blocked';
      } else if (name === 'v3 clean') {
        rawState = legacyState('standard');
        artifacts = legacyArtifacts();
        expected = 'ready';
      } else if (name === 'v3 invalid') {
        rawState = legacyState('standard');
        artifacts = legacyArtifacts('# Brief\n', {
          version: 1,
          passed: false,
          score: 0,
          issues: [{ code: 'bad', severity: 'error', taskId: null, message: 'bad' }],
        });
        expected = 'blocked';
      } else if (name === 'v3 zero-task') {
        rawState = legacyState('instant');
        artifacts = legacyArtifacts('# Empty Brief\n', {
          version: 1,
          passed: false,
          score: 0,
          issues: [
            { code: 'empty_task_list', severity: 'error', taskId: null, message: 'no tasks' },
          ],
        });
        expected = 'blocked';
      } else if (name === 'v3 missing evidence') {
        rawState = legacyState('quick');
        artifacts = { brief: null, report: null, queuedInputs: [] };
        expected = 'storage-blocked';
      } else if (name === 'v3 malformed evidence') {
        rawState = legacyState('standard');
        artifacts = legacyArtifacts('# Brief\n', '{not-json');
        expected = 'storage-blocked';
      } else if (name === 'v3 mismatched evidence') {
        rawState = legacyState('standard');
        artifacts = legacyArtifacts('# Brief\n', {
          version: 1,
          passed: true,
          score: 1,
          briefHash: 'wrong-hash',
          issues: [],
        });
        expected = 'storage-blocked';
      } else if (name === 'future state') {
        rawState = { ...legacyState(), stateVersion: 99 };
        artifacts = legacyArtifacts();
        expected = 'future-version';
      } else {
        rawState = { ...legacyState(), external: { recovery: { version: 99 } } };
        artifacts = legacyArtifacts();
        expected = 'future-version';
      }

      const result = await harness.controller.migrateBriefRecovery(
        { sessionId: SESSION_ID, rawState, artifacts },
        authorityForRaw(rawState),
      );
      expect(harness.providerCalls).toHaveLength(0);
      expect(result.projection.status).toBe(
        expected === 'future-version' ? 'storage-blocked' : expected,
      );
      if (expected === 'future-version') {
        expect(result.kind).toBe('future-version');
        expect(harness.mutations).toHaveLength(0);
      } else if (name.startsWith('v4 ')) {
        expect(result.kind).toBe('migrated');
        expect(harness.mutations).toHaveLength(0);
      } else {
        expect(harness.mutations.length).toBeLessThanOrEqual(1);
      }
    },
  );

  it.each(['v3 resume', 'v4 resume'] as const)(
    '%s preserves the owner-produced recovery projection and queue order',
    async (kind) => {
      const harness = makeHarness();
      let rawState: unknown;
      let artifacts: BriefRecoveryMigrationInput['artifacts'];
      let resumeAuthority: StateAuthorityReceipt;
      if (kind === 'v3 resume') {
        rawState = legacyState('standard', 'reviewing-briefs', [
          {
            id: 'queued-1',
            text: 'first queued input',
            queuedAt: NOW,
            phase: 'reviewing-briefs',
            deliveredViaNative: false,
            nativeDeliveryState: 'pending',
          },
          {
            id: 'queued-2',
            text: 'second queued input',
            queuedAt: NOW,
            phase: 'reviewing-briefs',
            deliveredViaNative: false,
            nativeDeliveryState: 'pending',
          },
        ]);
        artifacts = {
          ...legacyArtifacts(),
          queuedInputs: (rawState as WorkflowState).messageQueue,
        };
        resumeAuthority = harness.authority();
      } else {
        const source = makeHarness();
        await source.controller.enterBriefAdmission(
          makeAdmission('quick', 'initial', [qualityIssue()]),
          source.authority(),
        );
        rawState = workflowState(source.lastState()!);
        artifacts = legacyArtifacts();
        resumeAuthority = authorityForRaw(rawState);
      }
      const result = await harness.controller.migrateBriefRecovery(
        { sessionId: SESSION_ID, rawState, artifacts },
        resumeAuthority,
      );
      expect(harness.providerCalls).toHaveLength(0);
      expect(result.kind).toBe('migrated');
      if (kind === 'v3 resume') {
        expect(result.projection.queuedInputs.ids).toEqual(['queued-1', 'queued-2']);
        expect(result.projection.origin).toEqual({ mode: 'standard', entry: 'initial' });
        expect(harness.mutations).toHaveLength(1);
      } else {
        expect(result.projection.activeBrief?.path).toContain('tasks-quick-initial.md');
        expect(harness.mutations).toHaveLength(0);
      }
    },
  );
});

describe('Brief recovery provider, input, and accounting races', () => {
  it('keeps queued input history and the complete accounting key through an unresolved retry', async () => {
    const harness = makeHarness({
      providerPlan: async (input) => ({
        kind: 'ambiguous-failure' as const,
        requestId: input.requestId,
        dispatchPossibility: 'possible' as const,
        remoteObservation: 'unknown' as const,
        text: null,
        providerCode: 'provider-timeout',
        usage: null,
      }),
    });
    const admission = makeAdmission('quick', 'initial', [qualityIssue()]);
    const admitted = await harness.controller.enterBriefAdmission(admission, harness.authority());
    const epochId = admitted.epochId ?? 'missing';
    const queued = await harness.controller.queueBriefInput(
      {
        sessionId: SESSION_ID,
        epochId,
        inputId: 'held-input',
        sequence: 1,
        kind: 'feedback',
        source: 'interactive',
        payload: 'keep this feedback',
        base: admission.activeBrief,
        operationId: null,
      },
      harness.authority(1),
    );
    const result = await harness.controller.dispatchBriefAction(
      retryCommand(admission, epochId, 'unresolved-1', admission.activeBrief, ['held-input']),
      harness.authority(2),
    );
    expect(queued.kind).toBe('accepted');
    expect(result.kind).toBe('unresolved');
    expect(result.projection.remoteUsage).toBe('REMOTE USAGE UNKNOWN');
    expect(result.projection.budget?.state).toBe('held');
    expect(result.projection.queuedInputs.heldCount).toBe(1);
    const state = harness.lastState();
    const receipt =
      state?.briefRecovery && 'attempts' in state.briefRecovery
        ? state.briefRecovery.attempts['unresolved-1']
        : null;
    expect(receipt).toMatchObject({
      status: 'unresolved',
      dispatchPossibility: 'possible',
      reservation: {
        accountingKey: {
          sessionId: SESSION_ID,
          epochId,
          operationId: 'unresolved-1',
          generation: 0,
        },
        state: 'held',
        usageApplied: false,
      },
    });
    expect(
      state?.briefRecovery && 'inputs' in state.briefRecovery
        ? (state.briefRecovery.inputs.at(0)?.history.map((event) => event.state) ?? [])
        : [],
    ).toEqual(['queued', 'bound', 'held']);
    expect(harness.providerCalls).toHaveLength(1);
  });

  it('persists accepted, started, interrupted, settled, and superseded receipt outcomes', () => {
    const admission = makeAdmission('quick', 'initial', [qualityIssue()]);
    const initial = createBriefRecoveryState(admission, { epochId: 'receipt-epoch' });
    const key = {
      sessionId: SESSION_ID,
      epochId: initial.epochId,
      operationId: 'receipt-op',
      generation: 0,
    };
    const operation = {
      epochId: initial.epochId,
      operationId: key.operationId,
      intentHash: sha('receipt-intent'),
      kind: 'manual-retry' as const,
      acceptedAt: NOW,
      baseBrief: initial.activeBrief,
      baseReport: initial.matchingReport?.report ?? null,
      frozenInputIds: [],
      reservation: reservation(key),
    };
    const accepted = acceptRecoveryOperation(initial, operation, NOW);
    expect(accepted.receipt).toMatchObject({
      status: 'accepted',
      dispatchPossibility: 'none',
      reservation: { accountingKey: key, state: 'reserved', usageApplied: false },
    });
    const interrupted = interruptRecoveryOperation(accepted.state, key.operationId, NOW);
    expect(interrupted.receipt).toMatchObject({
      status: 'interrupted-not-dispatched',
      dispatchPossibility: 'none',
      reservation: { state: 'released' },
    });

    const started = startRecoveryOperation(accepted.state, {
      operationId: key.operationId,
      requestId: 'receipt-request',
      startedAt: NOW,
    });
    expect(started.receipt).toMatchObject({ status: 'started', dispatchPossibility: 'possible' });
    const settled = settleRecoveryOperation(started.state, {
      sessionId: SESSION_ID,
      epochId: initial.epochId,
      operationId: key.operationId,
      requestId: 'receipt-request',
      dispatchPossibility: 'possible',
      remoteObservation: 'confirmed-final',
      outcome: 'provider-failed',
      candidate: null,
      report: null,
      providerCode: 'provider-timeout',
      usage: null,
      settledAt: NOW,
    });
    expect(settled.receipt).toMatchObject({
      status: 'settled',
      dispatchPossibility: 'possible',
      outcome: 'provider-failed',
      reservation: { state: 'held', usageApplied: false },
    });
    const superseded = supersedeRecoveryOperation(started.state, {
      operationId: key.operationId,
      reason: 'edit',
      at: NOW,
    });
    expect(superseded.receipt).toMatchObject({
      status: 'superseded',
      dispatchPossibility: 'possible',
      resourceDisposition: 'held-superseded',
      reservation: { accountingKey: key, state: 'held' },
    });
  });

  it('returns a typed budget refusal before provider dispatch and preserves the public projection', async () => {
    const harness = makeHarness({ budgetRefused: true });
    const admission = makeAdmission('quick', 'initial', [qualityIssue()]);
    const admitted = await harness.controller.enterBriefAdmission(admission, harness.authority());
    const result = await harness.controller.dispatchBriefAction(
      retryCommand(admission, admitted.epochId ?? 'missing', 'budget-refused'),
      harness.authority(1),
    );
    if (result.kind !== 'blocked') throw new Error(`expected budget refusal, got ${result.kind}`);
    expect(result.code).toBe('brief_budget_exhausted');
    expect(result.projection.status).toBe('blocked');
    expect(result.projection.budget).toMatchObject({
      state: 'refused',
      refusalCode: 'brief_budget_exhausted',
    });
    expect(harness.providerCalls).toHaveLength(0);
    expect(harness.accounting.filter((call) => call.kind === 'estimate')).toHaveLength(1);
    expect(harness.accounting.filter((call) => call.kind === 'reserve')).toHaveLength(1);
    expect(harness.mutations).toHaveLength(2);
  });

  it('replays terminal rejection without a second write or provider call', async () => {
    const harness = makeHarness();
    const admission = makeAdmission('quick', 'initial', [qualityIssue()]);
    const admitted = await harness.controller.enterBriefAdmission(admission, harness.authority());
    const command = rejectCommand(admission, admitted.epochId ?? 'missing', 'reject-replay');
    const first = await harness.controller.dispatchBriefAction(command, harness.authority(1));
    const writes = harness.mutations.length;
    const publications = harness.published.length;
    const second = await harness.controller.dispatchBriefAction(command, harness.authority(2));
    expect(first.kind).toBe('rejected');
    expect(second.kind).toBe('rejected');
    expect(second.projection.status).toBe('rejected');
    expect(harness.mutations).toHaveLength(writes);
    expect(harness.published).toHaveLength(publications);
    expect(harness.lastState()?.briefRecovery).toMatchObject({ status: 'rejected', outbox: [] });
    expect(harness.providerCalls).toHaveLength(0);
  });

  it('records no-progress 19/20/21 boundaries and refuses the 21st unchanged retry', async () => {
    const sameIssues = [
      { code: 'same-failure', severity: 'warning' as const, taskId: null, message: 'same failure' },
    ];
    const admission = makeAdmission('quick', 'initial', sameIssues);
    let state = createBriefRecoveryState(admission, { epochId: 'no-progress-epoch' });
    const baseReport = state.matchingReport?.report ?? admission.report.report;
    for (let attempt = 1; attempt <= 20; attempt += 1) {
      const operationId = `no-progress-${attempt}`;
      const key = { sessionId: SESSION_ID, epochId: state.epochId, operationId, generation: 0 };
      const accepted = acceptRecoveryOperation(
        state,
        {
          epochId: state.epochId,
          operationId,
          intentHash: sha(`no-progress-intent-${attempt}`),
          kind: 'manual-retry',
          acceptedAt: NOW,
          baseBrief: state.activeBrief,
          baseReport,
          frozenInputIds: [],
          reservation: reservation(key),
        },
        NOW,
      );
      expect(accepted.kind).toBe('accepted');
      const started = startRecoveryOperation(accepted.state, {
        operationId,
        requestId: `no-progress-request-${attempt}`,
        startedAt: NOW,
      });
      expect(started.kind).toBe('accepted');
      const settled = settleRecoveryOperation(started.state, {
        sessionId: SESSION_ID,
        epochId: state.epochId,
        operationId,
        requestId: `no-progress-request-${attempt}`,
        dispatchPossibility: 'possible',
        remoteObservation: 'confirmed-final',
        outcome: 'quality-failed',
        candidate: null,
        report: null,
        providerCode: 'quality-failed',
        usage: null,
        settledAt: NOW,
      });
      expect(settled.kind).toBe('settled');
      state = settled.state as typeof state;
      if (attempt === 19) expect(state.noProgress.count).toBe(19);
      if (attempt === 20) expect(state.noProgress.count).toBe(20);
    }
    const refused = acceptRecoveryOperation(
      state,
      {
        epochId: state.epochId,
        operationId: 'no-progress-21',
        intentHash: sha('no-progress-intent-21'),
        kind: 'manual-retry',
        acceptedAt: NOW,
        baseBrief: state.activeBrief,
        baseReport,
        frozenInputIds: [],
        reservation: reservation({
          sessionId: SESSION_ID,
          epochId: state.epochId,
          operationId: 'no-progress-21',
          generation: 0,
        }),
      },
      NOW,
    );
    expect(refused.kind).toBe('refused');
    expect(refused.reason).toContain('threshold');
    const projection = makeHarness().controller.inspectBriefRecovery({
      sessionId: SESSION_ID,
      state: {
        stateVersion: 4,
        stateRevision: 20,
        stateFence: { token: FENCE, ownerId: OWNER_ID },
        phase: 'reviewing-briefs',
        briefRecovery: state,
      },
      now: NOW,
    });
    expect(projection.blocker).toMatchObject({
      kind: 'no-progress',
      code: 'brief_no_progress',
      count: 20,
    });
    expect(projection.allowedActions).not.toContain('retry');
  });

  it.each([
    ['accepted', 'edit', 'late-response', 'live'],
    ['accepted', 'edit', 'late-response', 'restart'],
    ['accepted', 'edit', 'no-response', 'live'],
    ['accepted', 'edit', 'no-response', 'restart'],
    ['accepted', 'reject', 'late-response', 'live'],
    ['accepted', 'reject', 'late-response', 'restart'],
    ['accepted', 'reject', 'no-response', 'live'],
    ['accepted', 'reject', 'no-response', 'restart'],
    ['started', 'edit', 'late-response', 'live'],
    ['started', 'edit', 'late-response', 'restart'],
    ['started', 'edit', 'no-response', 'live'],
    ['started', 'edit', 'no-response', 'restart'],
    ['started', 'reject', 'late-response', 'live'],
    ['started', 'reject', 'late-response', 'restart'],
    ['started', 'reject', 'no-response', 'live'],
    ['started', 'reject', 'no-response', 'restart'],
  ] as const)(
    '%s + %s + %s + %s retains one authoritative closure',
    async (stage, target, response, lifecycle) => {
      const providerRelease: { current: ((result: RecoveryProviderResult) => void) | null } = {
        current: null,
      };
      let providerStarted = false;
      const harness = makeHarness({
        failDispatchFence: stage === 'accepted',
        qualityIssues: [qualityIssue()],
        providerPlan: (_input) => {
          providerStarted = true;
          return new Promise<RecoveryProviderResult>((resolve) => {
            providerRelease.current = resolve;
          });
        },
      });
      const admission = makeAdmission('quick', 'initial', [qualityIssue()]);
      const admitted = await harness.controller.enterBriefAdmission(admission, harness.authority());
      const epochId = admitted.epochId ?? 'missing';
      const dispatch = harness.controller.dispatchBriefAction(
        retryCommand(admission, epochId, `race-${stage}-${target}`),
        harness.authority(1),
      );
      if (stage === 'started') {
        await waitFor(() => providerStarted);
      } else {
        await waitFor(() => harness.mutations.length === 2);
        expect(providerStarted).toBe(false);
      }
      const startedRevision = harness.lastState()?.stateRevision ?? 0;
      const targetCommand =
        target === 'edit'
          ? editCommand(admission, epochId, `race-${target}`)
          : rejectCommand(admission, epochId, `race-${target}`);
      const targetResult = await harness.controller.dispatchBriefAction(
        targetCommand,
        harness.authority(startedRevision),
      );
      expect(['blocked', 'rejected']).toContain(targetResult.kind);
      let restartedStatus: string | null = null;
      let restartedProviderCalls = 0;
      if (lifecycle === 'restart') {
        const rehydrated = makeHarness();
        const persisted = workflowState(
          harness.lastState()!,
          target === 'reject' ? 'idle' : 'reviewing-briefs',
        );
        const migrated = await rehydrated.controller.migrateBriefRecovery(
          { sessionId: SESSION_ID, rawState: persisted, artifacts: legacyArtifacts() },
          authorityForRaw(persisted),
        );
        restartedStatus = migrated.projection.status;
        restartedProviderCalls = rehydrated.providerCalls.length;
      }
      const releaseProvider = providerRelease.current;
      if (releaseProvider !== null) {
        releaseProvider(
          response === 'late-response'
            ? {
                kind: 'completed',
                requestId: 'matrix-request',
                dispatchPossibility: 'possible',
                remoteObservation: 'confirmed-final',
                text: 'late stale Brief',
                providerCode: null,
                usage: usage(),
              }
            : {
                kind: 'ambiguous-failure',
                requestId: 'matrix-request',
                dispatchPossibility: 'possible',
                remoteObservation: 'unknown',
                text: null,
                providerCode: 'no-response',
                usage: null,
              },
        );
      }
      const late = await dispatch;
      const final = harness.lastState();
      expect(final).not.toBeNull();
      expect(final?.stateFence).toEqual({ token: FENCE, ownerId: OWNER_ID });
      if (target === 'edit') {
        expect(final?.briefRecovery?.status).not.toBe('ready');
        expect(
          final?.briefRecovery && 'attempts' in final.briefRecovery
            ? Object.values(final.briefRecovery.attempts).some(
                (receipt) => receipt.status === 'superseded',
              )
            : false,
        ).toBe(true);
      } else {
        expect(final?.briefRecovery?.status).toBe('rejected');
      }
      expect(['stale-ignored', 'blocked', 'rejected']).toContain(late.kind);
      expect(harness.providerCalls).toHaveLength(stage === 'started' ? 1 : 0);
      if (stage === 'started') {
        expect(
          harness.accounting.some((call) => call.kind === 'reconcile' && call.state === 'held'),
        ).toBe(true);
        if (target === 'reject')
          expect(harness.accounting.some((call) => call.kind === 'terminal-charge')).toBe(true);
      }
      if (lifecycle === 'restart') {
        expect(restartedProviderCalls).toBe(0);
        expect(restartedStatus).toBe(final?.briefRecovery?.status);
      }
    },
  );
});
