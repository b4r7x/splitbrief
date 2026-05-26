import type { z } from 'zod';
import type { TreeEntryEnvelope } from './schemas.js';
import type { SessionTree } from './store.js';
import { activePath } from './store.js';
import { parseEntryAs } from './registry.js';
import {
  PlanStepPayloadSchema,
  AgentInvocationPayloadSchema,
  RecoveryDecisionPayloadSchema,
  FileStatePayloadSchema,
  CostCheckpointPayloadSchema,
  type PlanStepPayload,
  type AgentInvocationPayload,
  type RecoveryDecisionPayload,
  type FileStatePayload,
  type CostCheckpointPayload,
} from './entry-types.js';

export interface ReconstructedState {
  planSteps: PlanStepPayload[];
  agentInvocations: AgentInvocationPayload[];
  recoveryDecisions: RecoveryDecisionPayload[];
  fileStates: Map<string, FileStatePayload>;
  latestCostCheckpoint: CostCheckpointPayload | null;
  totalEntries: number;
}

export function reconstructState(tree: SessionTree): ReconstructedState {
  const path = activePath(tree);
  const rootFirst = [...path].reverse();

  const state: ReconstructedState = {
    planSteps: [],
    agentInvocations: [],
    recoveryDecisions: [],
    fileStates: new Map(),
    latestCostCheckpoint: null,
    totalEntries: rootFirst.length,
  };

  for (const envelope of rootFirst) {
    const planStep = parseEntryAs(envelope, 'plan-step', PlanStepPayloadSchema);
    if (planStep) {
      state.planSteps.push(planStep.payload);
      continue;
    }

    const invocation = parseEntryAs(envelope, 'agent-invocation', AgentInvocationPayloadSchema);
    if (invocation) {
      state.agentInvocations.push(invocation.payload);
      continue;
    }

    const recovery = parseEntryAs(envelope, 'recovery-decision', RecoveryDecisionPayloadSchema);
    if (recovery) {
      state.recoveryDecisions.push(recovery.payload);
      continue;
    }

    const fileState = parseEntryAs(envelope, 'file-state', FileStatePayloadSchema);
    if (fileState) {
      state.fileStates.set(fileState.payload.path, fileState.payload);
      continue;
    }

    const cost = parseEntryAs(envelope, 'cost-checkpoint', CostCheckpointPayloadSchema);
    if (cost) {
      state.latestCostCheckpoint = cost.payload;
    }
  }

  return state;
}

export function entriesOfType<T>(tree: SessionTree, type: string, schema: z.ZodType<T>): T[] {
  const path = activePath(tree);
  const results: T[] = [];
  for (const envelope of path) {
    const parsed = parseEntryAs(envelope, type, schema);
    if (parsed) results.push(parsed.payload);
  }
  return results;
}

export function displayableEntries(tree: SessionTree): TreeEntryEnvelope[] {
  const path = activePath(tree);
  return path.filter(e => e.display !== false);
}
