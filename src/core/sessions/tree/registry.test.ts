import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { entryId } from './schemas.js';
import {
  hasEntryType,
  getEntrySchema,
  registerEntryType,
  parseEntry,
  parseEntryAs,
} from './registry.js';
import { PlanStepPayloadSchema, AgentInvocationPayloadSchema } from './entry-types.js';

function makeEnvelope(type: string, payload: unknown) {
  return {
    id: entryId('E0001'),
    parentId: null,
    type,
    timestamp: 1000,
    payload,
  };
}

describe('hasEntryType', () => {
  it('returns true for built-in types', () => {
    expect(hasEntryType('session-start')).toBe(true);
    expect(hasEntryType('plan-step')).toBe(true);
    expect(hasEntryType('agent-invocation')).toBe(true);
    expect(hasEntryType('recovery-decision')).toBe(true);
    expect(hasEntryType('file-state')).toBe(true);
    expect(hasEntryType('cost-checkpoint')).toBe(true);
    expect(hasEntryType('branch-summary')).toBe(true);
  });

  it('returns false for unknown types', () => {
    expect(hasEntryType('unknown')).toBe(false);
  });
});

describe('getEntrySchema', () => {
  it('returns a schema for built-in types', () => {
    const schema = getEntrySchema('plan-step');
    expect(schema).toBeDefined();
  });

  it('returns undefined for unknown types', () => {
    expect(getEntrySchema('unknown')).toBeUndefined();
  });
});

describe('registerEntryType', () => {
  it('adds a new type to the registry', () => {
    const customSchema = z.object({ value: z.number() });
    registerEntryType('custom', customSchema);
    expect(hasEntryType('custom')).toBe(true);
    expect(getEntrySchema('custom')).toBe(customSchema);
  });
});

describe('parseEntry', () => {
  it('returns TypedEntry for valid payload', () => {
    const envelope = makeEnvelope('plan-step', {
      taskId: 'T001',
      title: 'Add login',
      file: 'src/auth.ts',
      action: 'create',
      description: 'Implement login form',
      index: 0,
      total: 3,
    });
    const result = parseEntry(envelope);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.payload).toEqual(envelope.payload);
    }
  });

  it('returns OpaqueEntry for invalid payload', () => {
    const envelope = makeEnvelope('plan-step', { bad: true });
    const result = parseEntry(envelope);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.type).toBe('plan-step');
    }
  });

  it('returns OpaqueEntry for unknown type', () => {
    const envelope = makeEnvelope('unknown', { data: true });
    const result = parseEntry(envelope);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.type).toBe('unknown');
    }
  });
});

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
});
