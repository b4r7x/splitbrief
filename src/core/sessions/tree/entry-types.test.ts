import { describe, it, expect } from 'vitest';
import { entryId, type EntryId } from './schemas.js';
import {
  SessionStartPayloadSchema,
  PlanStepPayloadSchema,
  AgentInvocationPayloadSchema,
  RecoveryDecisionPayloadSchema,
  FileStatePayloadSchema,
  CostCheckpointPayloadSchema,
  BranchSummaryPayloadSchema,
  createPlanStepEntry,
  createAgentInvocationEntry,
  createRecoveryDecisionEntry,
  createFileStateEntry,
  createCostCheckpointEntry,
  ENTRY_TYPES,
} from './entry-types.js';
import { taskId } from '../../schemas/task.js';

const baseOpts = {
  parentId: entryId('E0001') as EntryId,
  entryCount: 2,
  timestamp: 2000,
};

describe('ENTRY_TYPES', () => {
  it('contains all expected entry types', () => {
    expect(ENTRY_TYPES).toEqual([
      'session-start',
      'plan-step',
      'agent-invocation',
      'recovery-decision',
      'file-state',
      'cost-checkpoint',
      'branch-summary',
    ]);
  });
});

describe('SessionStartPayloadSchema', () => {
  it('accepts valid payload', () => {
    const result = SessionStartPayloadSchema.safeParse({ feature: 'auth', mode: 'quick' });
    expect(result.success).toBe(true);
  });

  it('accepts minimal payload', () => {
    const result = SessionStartPayloadSchema.safeParse({ feature: 'auth' });
    expect(result.success).toBe(true);
  });

  it('rejects missing feature', () => {
    const result = SessionStartPayloadSchema.safeParse({ mode: 'quick' });
    expect(result.success).toBe(false);
  });
});

describe('PlanStepPayloadSchema', () => {
  const valid = {
    taskId: taskId('T001'),
    title: 'Add login',
    file: 'src/auth.ts',
    action: 'create' as const,
    description: 'Implement login form',
    index: 0,
    total: 3,
  };

  it('accepts valid payload', () => {
    expect(PlanStepPayloadSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects negative index', () => {
    expect(PlanStepPayloadSchema.safeParse({ ...valid, index: -1 }).success).toBe(false);
  });

  it('rejects zero total', () => {
    expect(PlanStepPayloadSchema.safeParse({ ...valid, total: 0 }).success).toBe(false);
  });

  it('rejects invalid action', () => {
    expect(PlanStepPayloadSchema.safeParse({ ...valid, action: 'delete' }).success).toBe(false);
  });
});

describe('AgentInvocationPayloadSchema', () => {
  const valid = {
    role: 'planner' as const,
    tool: 'claude-code',
    phase: 'planning' as const,
    status: 'started' as const,
  };

  it('accepts valid payload', () => {
    expect(AgentInvocationPayloadSchema.safeParse(valid).success).toBe(true);
  });

  it('accepts payload with optional fields', () => {
    expect(AgentInvocationPayloadSchema.safeParse({
      ...valid,
      taskId: taskId('T001'),
      model: 'claude-3',
      durationMs: 1000,
      tokensUsed: 500,
      error: 'none',
    }).success).toBe(true);
  });

  it('rejects invalid role', () => {
    expect(AgentInvocationPayloadSchema.safeParse({ ...valid, role: 'unknown' }).success).toBe(false);
  });

  it('rejects negative durationMs', () => {
    expect(AgentInvocationPayloadSchema.safeParse({ ...valid, durationMs: -1 }).success).toBe(false);
  });
});

describe('RecoveryDecisionPayloadSchema', () => {
  const valid = {
    issueId: 'issue-1',
    reason: 'implementation-error' as const,
    selectedAction: 'retry-same-worker' as const,
    availableActions: ['retry-same-worker', 'route-bigger-worker'] as string[],
    message: 'Retrying',
  };

  it('accepts valid payload', () => {
    expect(RecoveryDecisionPayloadSchema.safeParse(valid).success).toBe(true);
  });

  it('accepts payload with optional fields', () => {
    expect(RecoveryDecisionPayloadSchema.safeParse({
      ...valid,
      taskId: taskId('T001'),
      outcome: 'continued' as const,
    }).success).toBe(true);
  });

  it('rejects invalid reason', () => {
    expect(RecoveryDecisionPayloadSchema.safeParse({ ...valid, reason: 'unknown' }).success).toBe(false);
  });

  it('rejects invalid outcome', () => {
    expect(RecoveryDecisionPayloadSchema.safeParse({ ...valid, outcome: 'unknown' }).success).toBe(false);
  });
});

describe('FileStatePayloadSchema', () => {
  const valid = {
    path: 'src/auth.ts',
    action: 'created' as const,
  };

  it('accepts valid payload', () => {
    expect(FileStatePayloadSchema.safeParse(valid).success).toBe(true);
  });

  it('accepts payload with optional fields', () => {
    expect(FileStatePayloadSchema.safeParse({
      ...valid,
      linesAdded: 10,
      linesRemoved: 2,
      hash: 'abc123',
      taskId: taskId('T001'),
    }).success).toBe(true);
  });

  it('rejects invalid action', () => {
    expect(FileStatePayloadSchema.safeParse({ ...valid, action: 'renamed' }).success).toBe(false);
  });

  it('rejects negative linesAdded', () => {
    expect(FileStatePayloadSchema.safeParse({ ...valid, linesAdded: -1 }).success).toBe(false);
  });
});

describe('CostCheckpointPayloadSchema', () => {
  const valid = {
    totalCost: 1.23,
    inputTokens: 100,
    outputTokens: 50,
    phase: 'implementing' as const,
  };

  it('accepts valid payload', () => {
    expect(CostCheckpointPayloadSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects negative totalCost', () => {
    expect(CostCheckpointPayloadSchema.safeParse({ ...valid, totalCost: -1 }).success).toBe(false);
  });

  it('rejects negative tokens', () => {
    expect(CostCheckpointPayloadSchema.safeParse({ ...valid, inputTokens: -1 }).success).toBe(false);
  });
});

describe('BranchSummaryPayloadSchema', () => {
  const valid = {
    goal: 'Fix auth',
    progress: ['step 1 done'],
    decisions: ['use jwt'],
    constraints: ['no deps'],
    nextSteps: ['test'],
    failureReason: 'timeout',
    entryCount: 5,
    durationMs: 10000,
  };

  it('accepts valid payload', () => {
    expect(BranchSummaryPayloadSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects negative entryCount', () => {
    expect(BranchSummaryPayloadSchema.safeParse({ ...valid, entryCount: -1 }).success).toBe(false);
  });
});

describe('createPlanStepEntry', () => {
  it('creates a plan-step envelope with parsed payload', () => {
    const payload = {
      taskId: taskId('T001'),
      title: 'Add login',
      file: 'src/auth.ts',
      action: 'create' as const,
      description: 'Implement login form',
      index: 0,
      total: 3,
    };
    const entry = createPlanStepEntry(payload, baseOpts);
    expect(entry.type).toBe('plan-step');
    expect(entry.id).toBe(entryId('E0003'));
    expect(entry.parentId).toBe(entryId('E0001'));
    expect(entry.timestamp).toBe(2000);
    expect(entry.display).toBe(true);
    expect(entry.payload).toEqual(payload);
  });

  it('respects display override', () => {
    const entry = createPlanStepEntry(
      { taskId: taskId('T001'), title: 'x', file: 'x.ts', action: 'create', description: 'd', index: 0, total: 1 },
      { ...baseOpts, display: false },
    );
    expect(entry.display).toBe(false);
  });

  it('throws on invalid payload', () => {
    expect(() =>
      createPlanStepEntry(
        { taskId: taskId('T001'), title: 'x', file: 'x.ts', action: 'create', description: 'd', index: 0, total: 0 } as unknown as Parameters<typeof createPlanStepEntry>[0],
        baseOpts,
      ),
    ).toThrow();
  });
});

describe('createAgentInvocationEntry', () => {
  it('creates an agent-invocation envelope with display false by default', () => {
    const payload = {
      role: 'planner' as const,
      tool: 'claude-code',
      phase: 'planning' as const,
      status: 'started' as const,
    };
    const entry = createAgentInvocationEntry(payload, baseOpts);
    expect(entry.type).toBe('agent-invocation');
    expect(entry.display).toBe(false);
  });

  it('respects display override', () => {
    const entry = createAgentInvocationEntry(
      { role: 'planner', tool: 't', phase: 'planning', status: 'started' },
      { ...baseOpts, display: true },
    );
    expect(entry.display).toBe(true);
  });
});

describe('createRecoveryDecisionEntry', () => {
  it('creates a recovery-decision envelope with display true by default', () => {
    const payload = {
      issueId: 'i1',
      reason: 'implementation-error',
      selectedAction: 'retry-same-worker',
      availableActions: ['retry-same-worker'],
      message: 'm',
    } as Parameters<typeof createRecoveryDecisionEntry>[0];
    const entry = createRecoveryDecisionEntry(payload, baseOpts);
    expect(entry.type).toBe('recovery-decision');
    expect(entry.display).toBe(true);
  });
});

describe('createFileStateEntry', () => {
  it('creates a file-state envelope with display false by default', () => {
    const payload = { path: 'src/x.ts', action: 'created' as const };
    const entry = createFileStateEntry(payload, baseOpts);
    expect(entry.type).toBe('file-state');
    expect(entry.display).toBe(false);
  });
});

describe('createCostCheckpointEntry', () => {
  it('creates a cost-checkpoint envelope with display false by default', () => {
    const payload = {
      totalCost: 1,
      inputTokens: 1,
      outputTokens: 1,
      phase: 'planning' as const,
    };
    const entry = createCostCheckpointEntry(payload, baseOpts);
    expect(entry.type).toBe('cost-checkpoint');
    expect(entry.display).toBe(false);
  });
});

describe('entry factory id generation', () => {
  it('generates sequential ids based on entryCount', () => {
    const opts = { parentId: null, entryCount: 5, timestamp: 1 };
    const e1 = createPlanStepEntry(
      { taskId: taskId('T001'), title: 'x', file: 'x.ts', action: 'create', description: 'd', index: 0, total: 1 },
      opts,
    );
    expect(e1.id).toBe(entryId('E0006'));
  });
});
