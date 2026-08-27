import { describe, expect, it } from 'vitest';
import { BriefRecoveryV1Schema } from './brief-recovery/document.js';
import type { RejectedStorageBriefRecoveryV1 } from './brief-recovery/document.js';
import { ChangedFilesSnapshotSchema, WorkflowStateSchema } from './workflow.js';
import { makeUsage } from '#testing/helpers/factories/summary.js';

const hash = 'a'.repeat(64);

const generation = {
  generationId: 'generation-1',
  manifestDigest: 'manifest-1',
  tasksDigest: 'tasks-1',
  qualityDigest: 'quality-1',
  programId: 'program-1',
} as const;

const approvalEvidence = { revision: 1, hash, path: 'brief-recovery/refusal.json' } as const;

const permit = {
  version: 1,
  epochId: 'epoch-1',
  authorityRevision: 2,
  generationId: generation.generationId,
  manifestDigest: generation.manifestDigest,
  tasksDigest: generation.tasksDigest,
  qualityDigest: generation.qualityDigest,
  approvalEvidence,
  issuedAt: '2026-08-13T00:00:00.000Z',
} as const;

const tokenUsage = makeUsage();

const task = {
  id: 'T001',
  title: 'Do work',
  action: 'modify',
  file: 'src/a.ts',
  dependsOn: [],
  description: 'Do work',
  tests: [],
  constraints: [],
  typeDefs: '',
  implementationSteps: [],
  status: 'pending',
};

function ref(path: string) {
  return { revision: 1, hash, path };
}

function report(hasError = false) {
  return {
    briefHash: hash,
    report: ref('brief-quality.json'),
    ruleVersion: 'brief-quality-v1',
    issues: hasError
      ? [{ code: 'empty_task_list', severity: 'error', taskId: null, message: 'No Task Briefs' }]
      : [],
  };
}

function attempt(status: 'accepted' | 'unresolved' = 'accepted') {
  return {
    epochId: 'epoch-1',
    operationId: 'operation-1',
    intentHash: hash,
    kind: 'manual-retry' as const,
    acceptedAt: '2026-08-13T00:00:00.000Z',
    baseBrief: ref('tasks.md'),
    baseReport: ref('brief-quality.json'),
    frozenInputIds: ['input-1'],
    status,
    dispatchPossibility: status === 'unresolved' ? ('possible' as const) : ('none' as const),
    ...(status === 'unresolved'
      ? {
          requestId: 'request-1',
          remoteObservation: 'unknown' as const,
          unresolvedAt: '2026-08-13T00:00:00.000Z',
        }
      : { automaticAllowanceConsumed: true }),
    reservation: {
      accountingKey: {
        sessionId: 'session-1',
        epochId: 'epoch-1',
        operationId: 'operation-1',
        generation: 1,
      },
      amount: 1,
      pricing: {
        budgetUnit: 'usd' as const,
        pricingIdentity: 'local-zero',
        inputPer1M: 0,
        outputPer1M: 0,
      },
      bookedAmount: 0,
      state: status === 'unresolved' ? ('held' as const) : ('reserved' as const),
      usageApplied: false,
      appliedUsage: null,
      history: [
        {
          state: status === 'unresolved' ? ('held' as const) : ('reserved' as const),
          at: '2026-08-13T00:00:00.000Z',
          reason: status === 'unresolved' ? ('unresolved' as const) : ('accepted' as const),
        },
      ],
    },
  };
}

function recovery(
  status:
    | 'checking'
    | 'auto-repairing'
    | 'blocked'
    | 'retrying'
    | 'unresolved'
    | 'ready'
    | 'readiness-blocked'
    | 'rejected' = 'checking',
) {
  const active = status === 'retrying' || status === 'unresolved' || status === 'auto-repairing';
  return {
    version: 1 as const,
    recoveryRevision: 1,
    epochId: 'epoch-1',
    origin: { mode: 'standard' as const, entry: 'initial' as const },
    continuation: {
      version: 1 as const,
      kind: 'approval' as const,
      mode: 'standard' as const,
      entry: 'initial' as const,
    },
    status,
    activeBrief: ref('tasks.md'),
    matchingReport: report(status === 'blocked' || status === 'unresolved'),
    qualityPolicyVersion: 'brief-quality-v1',
    automaticRepair: {
      policy: 'existing-one-shot' as const,
      eligible: true,
      consumed: true,
      operationId: 'operation-1',
    },
    attempts: active
      ? { 'operation-1': attempt(status === 'unresolved' ? 'unresolved' : 'accepted') }
      : {},
    activeOperationId: active ? 'operation-1' : null,
    inputs: [],
    nextInputSequence: 1,
    noProgress: { fingerprint: null, count: 0 },
    evidenceHead: hash,
    outbox: [],
  };
}

function storageBlockedRecovery() {
  return {
    version: 1 as const,
    recoveryRevision: 1,
    epochId: 'epoch-1',
    origin: { mode: 'standard' as const, entry: 'initial' as const },
    continuation: {
      version: 1 as const,
      kind: 'approval' as const,
      mode: 'standard' as const,
      entry: 'initial' as const,
    },
    status: 'storage-blocked' as const,
    activeBrief: null,
    storageEvidence: { code: 'brief_storage_invalid' as const, artifactRef: 'tasks.md' },
    evidenceHead: hash,
    outbox: [],
  };
}

function rejectedStorageRecovery(): RejectedStorageBriefRecoveryV1 {
  return { ...storageBlockedRecovery(), status: 'rejected' };
}

function state(
  overrides: Partial<{
    phase: string;
    currentTaskIndex: number;
    tasks: (typeof task)[];
    briefRecovery:
      | ReturnType<typeof recovery>
      | ReturnType<typeof storageBlockedRecovery>
      | ReturnType<typeof rejectedStorageRecovery>
      | null;
    authorityRevision: number;
    generation: typeof generation | null;
    permit: typeof permit | null;
  }> = {},
) {
  return {
    stateVersion: 4,
    stateRevision: 1,
    stateFence: { token: 1, ownerId: 'owner-1' },
    phase: 'reviewing-briefs',
    feature: 'quality recovery',
    currentTaskIndex: 0,
    attempt: 0,
    tasks: [],
    startedAt: '2026-08-13T00:00:00.000Z',
    tokenUsage,
    briefRecovery: recovery(),
    ...overrides,
  };
}

describe('WorkflowStateSchema v4 Brief recovery contract', () => {
  it('parses the complete changed-files snapshot contract', () => {
    const snapshot = {
      head: 'abc123',
      files: ['src/a.ts'],
      dirtyFileContents: { 'src/a.ts': 'before\n' },
      gitlinks: ['vendor/module'],
      baselineFileHashes: { 'src/a.ts': 'hash' },
      ignoreProjectDir: '/tmp/staged-project',
    };

    expect(ChangedFilesSnapshotSchema.parse(snapshot)).toEqual(snapshot);
  });

  it.each([
    'checking',
    'auto-repairing',
    'blocked',
    'retrying',
    'unresolved',
    'ready',
    'readiness-blocked',
  ] as const)('accepts reviewing-briefs with %s recovery', (status) => {
    expect(WorkflowStateSchema.safeParse(state({ briefRecovery: recovery(status) })).success).toBe(
      true,
    );
  });

  it('accepts a storage-blocked v4 recovery record', () => {
    const value = state({ briefRecovery: storageBlockedRecovery() });
    expect(WorkflowStateSchema.safeParse(value).success).toBe(true);
    expect(BriefRecoveryV1Schema.safeParse(value.briefRecovery).success).toBe(true);
  });

  it.each(['implementing', 'validating-task', 'escalating', 'final-review'] as const)(
    'retains ready Brief recovery through the %s execution phase',
    (phase) => {
      expect(
        WorkflowStateSchema.safeParse(
          state({ phase, tasks: [task], briefRecovery: recovery('ready') }),
        ).success,
      ).toBe(true);
    },
  );

  it('accepts the sole cross-phase archive exception: idle with rejected recovery', () => {
    expect(
      WorkflowStateSchema.safeParse(state({ phase: 'idle', briefRecovery: recovery('rejected') }))
        .success,
    ).toBe(true);
    const rejectedStorage = rejectedStorageRecovery();
    const parsed = WorkflowStateSchema.safeParse(
      state({ phase: 'idle', briefRecovery: rejectedStorage }),
    );
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.briefRecovery).toMatchObject({
        status: 'rejected',
        activeBrief: null,
        storageEvidence: rejectedStorage.storageEvidence,
      });
    }
    expect(
      WorkflowStateSchema.safeParse(state({ phase: 'idle', briefRecovery: null })).success,
    ).toBe(true);
  });

  it('rejects every other cross-phase recovery combination', () => {
    expect(
      WorkflowStateSchema.safeParse(state({ phase: 'reviewing-briefs', briefRecovery: null }))
        .success,
    ).toBe(true);
    expect(
      WorkflowStateSchema.safeParse(
        state({ phase: 'reviewing-briefs', briefRecovery: recovery('rejected') }),
      ).success,
    ).toBe(false);
    expect(
      WorkflowStateSchema.safeParse(
        state({ phase: 'planning', briefRecovery: recovery('blocked') }),
      ).success,
    ).toBe(false);
    expect(
      WorkflowStateSchema.safeParse(state({ phase: 'idle', briefRecovery: recovery('ready') }))
        .success,
    ).toBe(false);
    expect(
      WorkflowStateSchema.safeParse(
        state({ phase: 'idle', briefRecovery: storageBlockedRecovery() }),
      ).success,
    ).toBe(false);
    expect(
      WorkflowStateSchema.safeParse(
        state({
          phase: 'reviewing-briefs',
          briefRecovery: rejectedStorageRecovery(),
        }),
      ).success,
    ).toBe(false);
  });

  it('requires v4 persistence identity and rejects v3 or future state versions', () => {
    expect(WorkflowStateSchema.safeParse({ ...state(), stateVersion: 3 }).success).toBe(false);
    expect(WorkflowStateSchema.safeParse({ ...state(), stateVersion: 5 }).success).toBe(false);
    expect(WorkflowStateSchema.safeParse({ ...state(), stateRevision: undefined }).success).toBe(
      false,
    );
    expect(WorkflowStateSchema.safeParse({ ...state(), stateFence: undefined }).success).toBe(
      false,
    );
    expect(
      WorkflowStateSchema.safeParse({ ...state(), stateFence: { token: 1, ownerId: '' } }).success,
    ).toBe(false);
    expect(WorkflowStateSchema.safeParse({ ...state(), briefRecovery: undefined }).success).toBe(
      true,
    );
  });

  it('reads legacy v4 without inventing generation or permit authority', () => {
    const legacy = { ...state(), briefRecovery: undefined };
    const parsed = WorkflowStateSchema.safeParse(legacy);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.generation).toBeUndefined();
      expect(parsed.data.permit).toBeUndefined();
      expect(parsed.data.briefRecovery).toBeNull();
    }
  });

  it('accepts a generation/permit tuple backed by ready recovery', () => {
    expect(
      WorkflowStateSchema.safeParse({
        ...state(),
        authorityRevision: 2,
        generation,
        permit,
        briefRecovery: recovery('ready'),
      }).success,
    ).toBe(true);
  });

  it('requires a current permit to have ready recovery authority', () => {
    expect(
      WorkflowStateSchema.safeParse({
        ...state(),
        authorityRevision: 2,
        generation,
        permit,
        briefRecovery: storageBlockedRecovery(),
      }).success,
    ).toBe(false);
    expect(
      WorkflowStateSchema.safeParse({
        ...state(),
        authorityRevision: 2,
        generation,
        permit,
        briefRecovery: null,
      }).success,
    ).toBe(false);
    expect(
      WorkflowStateSchema.safeParse({
        ...state(),
        authorityRevision: 2,
        generation,
        permit,
        briefRecovery: undefined,
      }).success,
    ).toBe(false);
    expect(
      WorkflowStateSchema.safeParse({
        ...state(),
        authorityRevision: 2,
        generation,
        permit,
        briefRecovery: recovery('blocked'),
      }).success,
    ).toBe(false);
  });

  it.each([
    {
      authorityRevision: undefined,
      generation,
      permit,
    },
    {
      authorityRevision: 2,
      generation: null,
      permit,
    },
    {
      authorityRevision: 3,
      generation,
      permit,
    },
    {
      authorityRevision: 2,
      generation: { ...generation, tasksDigest: 'different-tasks' },
      permit,
    },
  ])('rejects an invalid generation/revision/permit combination', (authority) => {
    expect(WorkflowStateSchema.safeParse({ ...state(), ...authority }).success).toBe(false);
  });

  it('rejects unknown nested versions and impossible recovery resources', () => {
    expect(
      WorkflowStateSchema.safeParse({
        ...state(),
        briefRecovery: { ...recovery('blocked'), version: 2 },
      }).success,
    ).toBe(false);
    expect(
      WorkflowStateSchema.safeParse({
        ...state(),
        briefRecovery: { ...storageBlockedRecovery(), version: 2 },
      }).success,
    ).toBe(false);
    expect(
      WorkflowStateSchema.safeParse({
        ...state(),
        briefRecovery: {
          ...recovery('ready'),
          matchingReport: { ...report(true) },
        },
      }).success,
    ).toBe(false);
  });

  it('retains task graph and active-index invariants under v4', () => {
    expect(
      WorkflowStateSchema.safeParse(state({ tasks: [task, { ...task, title: 'Duplicate' }] }))
        .success,
    ).toBe(false);
    expect(
      WorkflowStateSchema.safeParse(
        state({ phase: 'validating-task', tasks: [], briefRecovery: null }),
      ).success,
    ).toBe(false);
    expect(
      WorkflowStateSchema.safeParse(
        state({ phase: 'implementing', currentTaskIndex: 2, tasks: [task], briefRecovery: null }),
      ).success,
    ).toBe(false);
    expect(
      WorkflowStateSchema.safeParse(
        state({
          phase: 'implementing',
          currentTaskIndex: 1,
          tasks: [{ ...task, status: 'done' }],
          briefRecovery: null,
        }),
      ).success,
    ).toBe(true);
  });

  it('rejects unknown top-level persisted fields instead of silently accepting them', () => {
    expect(
      WorkflowStateSchema.safeParse({
        ...state(),
        clarifications: [{ id: 'c1', question: 'q', answer: 'a' }],
      }).success,
    ).toBe(false);
  });
});
