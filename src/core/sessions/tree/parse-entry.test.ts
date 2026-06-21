import { describe, it, expect } from 'vitest';
import { entryId } from './schemas.js';
import { parseEntryAs } from './parse-entry.js';
import { PlanStepPayloadSchema, AgentInvocationPayloadSchema } from './payloads.js';

function makeEnvelope(type: string, payload: unknown) {
  return {
    id: entryId('E0001'),
    parentId: null,
    type,
    timestamp: 1000,
    payload,
  };
}

describe('parseEntryAs', () => {
  it('returns TypedEntry when type matches and payload is valid', () => {
    const envelope = makeEnvelope('plan-step', {
      taskId: 'T001',
      title: 'Add login',
      file: 'src/auth.ts',
      action: 'create',
      description: 'Implement login form',
      index: 0,
      total: 3,
    });
    const result = parseEntryAs(envelope, 'plan-step', PlanStepPayloadSchema);
    expect(result).not.toBeNull();
    expect(result!.valid).toBe(true);
    expect(result!.payload).toEqual(envelope.payload);
  });

  it('returns null when type does not match', () => {
    const envelope = makeEnvelope('agent-invocation', {
      role: 'planner',
      tool: 'claude-code',
      phase: 'planning',
      status: 'started',
    });
    const result = parseEntryAs(envelope, 'plan-step', PlanStepPayloadSchema);
    expect(result).toBeNull();
  });

  it('returns null when payload is invalid', () => {
    const envelope = makeEnvelope('plan-step', { bad: true });
    const result = parseEntryAs(envelope, 'plan-step', PlanStepPayloadSchema);
    expect(result).toBeNull();
  });

  it('returns TypedEntry for agent-invocation with correct schema', () => {
    const envelope = makeEnvelope('agent-invocation', {
      role: 'planner',
      tool: 'claude-code',
      phase: 'planning',
      status: 'started',
    });
    const result = parseEntryAs(envelope, 'agent-invocation', AgentInvocationPayloadSchema);
    expect(result).not.toBeNull();
    expect(result!.valid).toBe(true);
  });

  it('uses canonical runner call role and status values for agent-invocation', () => {
    expect(
      AgentInvocationPayloadSchema.safeParse({
        role: 'escalation',
        backendKind: 'agent-sdk',
        tool: 'claude-code',
        phase: 'implementing',
        status: 'unsupported_tool',
      }).success,
    ).toBe(true);
    expect(
      AgentInvocationPayloadSchema.safeParse({
        role: 'escalator',
        tool: 'claude-code',
        phase: 'implementing',
        status: 'started',
      }).success,
    ).toBe(false);
  });

  it('validates agent-invocation usage with the shared runner call usage contract', () => {
    expect(
      AgentInvocationPayloadSchema.safeParse({
        role: 'planner',
        tool: 'claude-code',
        phase: 'planning',
        status: 'completed',
        usage: {
          inputTokens: 10,
          outputTokens: 20,
          reasoningTokens: 5,
        },
      }).success,
    ).toBe(true);
    expect(
      AgentInvocationPayloadSchema.safeParse({
        role: 'planner',
        tool: 'claude-code',
        phase: 'planning',
        status: 'completed',
        usage: {
          inputTokens: 10,
          outputTokens: -1,
        },
      }).success,
    ).toBe(false);
  });
});
