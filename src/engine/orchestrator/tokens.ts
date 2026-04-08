import type { WorkflowState, TokenUsage, PlannerTokenUsage, ImplementerTokenUsage } from '../../types.js';

export type UsageCategory = 'planner' | 'implementer' | 'escalation';

const categoryFields: Record<UsageCategory, { input: keyof TokenUsage; output: keyof TokenUsage }> = {
  planner: { input: 'plannerInput', output: 'plannerOutput' },
  implementer: { input: 'implementerInput', output: 'implementerOutput' },
  escalation: { input: 'escalationInput', output: 'escalationOutput' },
};

export function addUsage(
  state: WorkflowState,
  category: UsageCategory,
  usage: PlannerTokenUsage | ImplementerTokenUsage | null | undefined,
): WorkflowState {
  if (!usage) return state;
  const input = usage.inputTokens;
  const output = usage.outputTokens;
  const fields = categoryFields[category];
  return {
    ...state,
    tokenUsage: {
      ...state.tokenUsage,
      [fields.input]: state.tokenUsage[fields.input] + input,
      [fields.output]: state.tokenUsage[fields.output] + output,
    },
  };
}

export function tokenDelta(before: TokenUsage, after: TokenUsage): { implementerTokens: number; escalationTokens: number } {
  const implementerBefore = before.implementerInput + before.implementerOutput;
  const implementerAfter = after.implementerInput + after.implementerOutput;
  const escBefore = before.escalationInput + before.escalationOutput;
  const escAfter = after.escalationInput + after.escalationOutput;
  return {
    implementerTokens: implementerAfter - implementerBefore,
    escalationTokens: escAfter - escBefore,
  };
}
