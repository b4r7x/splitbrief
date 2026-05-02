import { describe, it, expect } from 'vitest';
import { createEmptyTree, appendEntry, branchFrom } from './store.js';
import { entryId } from './schemas.js';
import { taskId } from '../../schemas/task.js';
import {
  createPlanStepEntry,
  createAgentInvocationEntry,
  createRecoveryDecisionEntry,
  createFileStateEntry,
  createCostCheckpointEntry,
} from './entry-types.js';
import {
  PlanStepPayloadSchema,
  CostCheckpointPayloadSchema,
} from './entry-types.js';
import {
  reconstructState,
  entriesOfType,
  displayableEntries,
} from './reconstruct.js';

function buildTreeWithEntries() {
  let tree = createEmptyTree(1000);

  const step1 = createPlanStepEntry(
    { taskId: taskId('T001'), title: 'Step 1', file: 'src/a.ts', action: 'create', description: 'd1', index: 0, total: 2 },
    { parentId: tree.meta.leafId, entryCount: tree.meta.entryCount, timestamp: 2000 },
  );
  const r1 = appendEntry(tree, { type: step1.type, payload: step1.payload, timestamp: step1.timestamp, display: step1.display! });
  tree = r1.tree;

  const agent1 = createAgentInvocationEntry(
    { role: 'planner', tool: 'claude-code', phase: 'planning', status: 'started' },
    { parentId: tree.meta.leafId, entryCount: tree.meta.entryCount, timestamp: 3000 },
  );
  const r2 = appendEntry(tree, { type: agent1.type, payload: agent1.payload, timestamp: agent1.timestamp, display: agent1.display! });
  tree = r2.tree;

  const step2 = createPlanStepEntry(
    { taskId: taskId('T002'), title: 'Step 2', file: 'src/b.ts', action: 'modify', description: 'd2', index: 1, total: 2 },
    { parentId: tree.meta.leafId, entryCount: tree.meta.entryCount, timestamp: 4000 },
  );
  const r3 = appendEntry(tree, { type: step2.type, payload: step2.payload, timestamp: step2.timestamp, display: step2.display! });
  tree = r3.tree;

  return tree;
}

describe('reconstructState', () => {
  it('extracts plan steps in root-first order', () => {
    const tree = buildTreeWithEntries();
    const state = reconstructState(tree);
    expect(state.planSteps).toHaveLength(2);
    expect(state.planSteps[0]!.title).toBe('Step 1');
    expect(state.planSteps[1]!.title).toBe('Step 2');
  });

  it('extracts agent invocations', () => {
    const tree = buildTreeWithEntries();
    const state = reconstructState(tree);
    expect(state.agentInvocations).toHaveLength(1);
    expect(state.agentInvocations[0]!.role).toBe('planner');
  });

  it('accumulates file states with later overwriting earlier', () => {
    let tree = createEmptyTree(1000);

    const f1 = createFileStateEntry(
      { path: 'src/x.ts', action: 'created' },
      { parentId: tree.meta.leafId, entryCount: tree.meta.entryCount, timestamp: 2000 },
    );
    const r1 = appendEntry(tree, { type: f1.type, payload: f1.payload, timestamp: f1.timestamp, display: f1.display! });
    tree = r1.tree;

    const f2 = createFileStateEntry(
      { path: 'src/x.ts', action: 'modified' },
      { parentId: tree.meta.leafId, entryCount: tree.meta.entryCount, timestamp: 3000 },
    );
    const r2 = appendEntry(tree, { type: f2.type, payload: f2.payload, timestamp: f2.timestamp, display: f2.display! });
    tree = r2.tree;

    const state = reconstructState(tree);
    expect(state.fileStates.size).toBe(1);
    expect(state.fileStates.get('src/x.ts')!.action).toBe('modified');
  });

  it('keeps the latest cost checkpoint', () => {
    let tree = createEmptyTree(1000);

    const c1 = createCostCheckpointEntry(
      { totalCost: 1, inputTokens: 10, outputTokens: 5, phase: 'planning' },
      { parentId: tree.meta.leafId, entryCount: tree.meta.entryCount, timestamp: 2000 },
    );
    const r1 = appendEntry(tree, { type: c1.type, payload: c1.payload, timestamp: c1.timestamp, display: c1.display! });
    tree = r1.tree;

    const c2 = createCostCheckpointEntry(
      { totalCost: 2, inputTokens: 20, outputTokens: 10, phase: 'implementing' },
      { parentId: tree.meta.leafId, entryCount: tree.meta.entryCount, timestamp: 3000 },
    );
    const r2 = appendEntry(tree, { type: c2.type, payload: c2.payload, timestamp: c2.timestamp, display: c2.display! });
    tree = r2.tree;

    const state = reconstructState(tree);
    expect(state.latestCostCheckpoint).not.toBeNull();
    expect(state.latestCostCheckpoint!.totalCost).toBe(2);
    expect(state.latestCostCheckpoint!.phase).toBe('implementing');
  });

  it('counts total entries on the active path', () => {
    const tree = buildTreeWithEntries();
    const state = reconstructState(tree);
    expect(state.totalEntries).toBe(4);
  });

  it('returns empty state for empty tree', () => {
    const tree = createEmptyTree(1000);
    const state = reconstructState(tree);
    expect(state.planSteps).toEqual([]);
    expect(state.agentInvocations).toEqual([]);
    expect(state.recoveryDecisions).toEqual([]);
    expect(state.fileStates.size).toBe(0);
    expect(state.latestCostCheckpoint).toBeNull();
    expect(state.totalEntries).toBe(1);
  });

  it('collects recovery decisions', () => {
    let tree = createEmptyTree(1000);

    const rec = createRecoveryDecisionEntry(
      { issueId: 'i1', reason: 'implementation-error', selectedAction: 'retry-same-worker', availableActions: ['retry-same-worker'], message: 'm' },
      { parentId: tree.meta.leafId, entryCount: tree.meta.entryCount, timestamp: 2000 },
    );
    const r1 = appendEntry(tree, { type: rec.type, payload: rec.payload, timestamp: rec.timestamp, display: rec.display! });
    tree = r1.tree;

    const state = reconstructState(tree);
    expect(state.recoveryDecisions).toHaveLength(1);
    expect(state.recoveryDecisions[0]!.issueId).toBe('i1');
  });

  it('only considers entries on the active path after a branch', () => {
    let tree = createEmptyTree(1000);

    const step1 = createPlanStepEntry(
      { taskId: taskId('T001'), title: 'Main', file: 'src/a.ts', action: 'create', description: 'd', index: 0, total: 1 },
      { parentId: tree.meta.leafId, entryCount: tree.meta.entryCount, timestamp: 2000 },
    );
    const r1 = appendEntry(tree, { type: step1.type, payload: step1.payload, timestamp: step1.timestamp, display: step1.display! });
    tree = r1.tree;

    const branchStep = createPlanStepEntry(
      { taskId: taskId('T002'), title: 'Branch', file: 'src/b.ts', action: 'create', description: 'd', index: 0, total: 1 },
      { parentId: entryId('E0001'), entryCount: tree.meta.entryCount, timestamp: 3000 },
    );
    const r2 = branchFrom(tree, { fromId: entryId('E0001'), type: branchStep.type, payload: branchStep.payload, timestamp: branchStep.timestamp, display: branchStep.display! });
    tree = r2.tree;

    const state = reconstructState(tree);
    expect(state.planSteps).toHaveLength(1);
    expect(state.planSteps[0]!.title).toBe('Branch');
  });
});

describe('entriesOfType', () => {
  it('returns all payloads of the requested type on active path in leaf-to-root order', () => {
    const tree = buildTreeWithEntries();
    const steps = entriesOfType(tree, 'plan-step', PlanStepPayloadSchema);
    expect(steps).toHaveLength(2);
    expect(steps[0]!.title).toBe('Step 2');
    expect(steps[1]!.title).toBe('Step 1');
  });

  it('returns empty array when no matching entries', () => {
    const tree = buildTreeWithEntries();
    const costs = entriesOfType(tree, 'cost-checkpoint', CostCheckpointPayloadSchema);
    expect(costs).toEqual([]);
  });

  it('filters by schema validity', () => {
    let tree = createEmptyTree(1000);
    const r1 = appendEntry(tree, {
      type: 'plan-step',
      payload: { taskId: 'T001', title: 'Valid', file: 'a.ts', action: 'create', description: 'd', index: 0, total: 1 },
      timestamp: 2000,
    });
    tree = r1.tree;
    const r2 = appendEntry(tree, {
      type: 'plan-step',
      payload: { invalid: true },
      timestamp: 3000,
    });
    tree = r2.tree;

    const steps = entriesOfType(tree, 'plan-step', PlanStepPayloadSchema);
    expect(steps).toHaveLength(1);
    expect(steps[0]!.title).toBe('Valid');
  });
});

describe('displayableEntries', () => {
  it('returns only entries with display !== false', () => {
    let tree = createEmptyTree(1000);

    const step = createPlanStepEntry(
      { taskId: taskId('T001'), title: 'Visible', file: 'a.ts', action: 'create', description: 'd', index: 0, total: 1 },
      { parentId: tree.meta.leafId, entryCount: tree.meta.entryCount, timestamp: 2000 },
    );
    const r1 = appendEntry(tree, { type: step.type, payload: step.payload, timestamp: step.timestamp, display: step.display! });
    tree = r1.tree;

    const agent = createAgentInvocationEntry(
      { role: 'planner', tool: 't', phase: 'planning', status: 'started' },
      { parentId: tree.meta.leafId, entryCount: tree.meta.entryCount, timestamp: 3000 },
    );
    const r2 = appendEntry(tree, { type: agent.type, payload: agent.payload, timestamp: agent.timestamp, display: agent.display! });
    tree = r2.tree;

    const displayable = displayableEntries(tree);
    expect(displayable).toHaveLength(2);
    expect(displayable[0]!.type).toBe('plan-step');
    expect(displayable[1]!.type).toBe('session-start');
  });

  it('includes entries without display property', () => {
    let tree = createEmptyTree(1000);
    const r1 = appendEntry(tree, { type: 'message', payload: {}, timestamp: 2000 });
    tree = r1.tree;
    const displayable = displayableEntries(tree);
    expect(displayable).toHaveLength(2);
  });
});
