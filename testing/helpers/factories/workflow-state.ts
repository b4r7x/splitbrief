import type { Task } from '../../../src/core/schemas/task.js';
import type { WorkflowState } from '../../../src/core/schemas/workflow.js';
import type {
  BriefGenerationRef,
  TaskExecutionPermit,
} from '../../../src/core/schemas/brief-owner.js';
import { createInitialState, transition } from '../../../src/core/state/machine.js';
import { createBriefRecoveryState } from '../../../src/engine/orchestrator/planning/brief-recovery.js';

export function makeImplState(tasks: Task[], overrides?: Partial<WorkflowState>): WorkflowState {
  let state = createInitialState('feat');
  state = transition(state, { type: 'START' });
  state = transition(state, { type: 'RESEARCH_DONE' });
  state = transition(state, { type: 'SPEC_DONE' });
  state = transition(state, { type: 'APPROVE_SPEC' });
  state = transition(state, { type: 'PLAN_DONE', tasks });
  const briefRecovery = createBriefRecoveryState({
    sessionId: 'workflow-state-fixture',
    origin: { mode: 'standard', entry: 'initial' },
    continuation: { version: 1, kind: 'approval', mode: 'standard', entry: 'initial' },
    activeBrief: { revision: 1, hash: 'b'.repeat(64), path: 'tasks.md' },
    report: {
      briefHash: 'b'.repeat(64),
      report: { revision: 1, hash: 'r'.repeat(64), path: 'brief-quality.json' },
      ruleVersion: 'brief-quality-v1',
      issues: [],
      errorCount: 0,
    },
    qualityPolicyVersion: 'brief-quality-v1',
  });
  state = transition(state, { type: 'BRIEF_ADMISSION_OPENED', briefRecovery });
  const generation = {
    generationId: 'workflow-state-fixture-generation',
    manifestDigest: 'workflow-state-fixture-manifest',
    tasksDigest: 'workflow-state-fixture-tasks',
    qualityDigest: 'workflow-state-fixture-quality',
    programId: null,
  } satisfies BriefGenerationRef;
  const permit = {
    version: 1,
    epochId: briefRecovery.epochId,
    authorityRevision: 1,
    generationId: generation.generationId,
    manifestDigest: generation.manifestDigest,
    tasksDigest: generation.tasksDigest,
    qualityDigest: generation.qualityDigest,
    approvalEvidence: {
      revision: 1,
      hash: 'r'.repeat(64),
      path: 'brief-quality.json',
    },
    issuedAt: '2026-01-01T00:00:00.000Z',
  } satisfies TaskExecutionPermit;
  state = {
    ...state,
    authorityRevision: 1,
    generation,
    permit,
  };
  state = transition(state, { type: 'BEGIN_IMPLEMENTATION', generation, permit });
  return { ...state, ...overrides };
}

export function makeImplStateWithMetadata(tasks: Task[]): WorkflowState {
  return makeImplState(tasks, {
    implementerTool: 'ollama',
    implementerModel: 'qwen2.5',
    plannerTool: 'claude-code',
  });
}
