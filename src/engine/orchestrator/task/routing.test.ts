import { describe, expect, it } from 'vitest';
import { configForProfile, selectedProfileFromDecision, routingBlockMessage } from './routing.js';
import type { ResolvedImplementerProfile } from '../../../core/config/accessors/implementer-profiles.js';
import type { RoutingDecision } from '../context-routing/types.js';
import type { WorkflowContext } from '../types.js';

describe('configForProfile', () => {
  it('merges profile config into workflow config', () => {
    const config = {
      implementer: { provider: 'openai' as const, model: 'gpt-4' },
    } as WorkflowContext['config'];
    const profile = {
      config: { provider: 'ollama' as const, model: 'qwen' },
    } as ResolvedImplementerProfile;
    const result = configForProfile(config, profile);
    expect(result.implementer).toEqual({ provider: 'ollama', model: 'qwen' });
  });
});

describe('selectedProfileFromDecision', () => {
  it('returns undefined when no profile selected', () => {
    const decision = { selectedProfile: undefined } as RoutingDecision;
    expect(selectedProfileFromDecision([], decision)).toBeUndefined();
  });

  it('finds matching profile by name', () => {
    const profiles = [{ name: 'local' }, { name: 'cloud' }] as ResolvedImplementerProfile[];
    const decision = { selectedProfile: 'cloud' } as RoutingDecision;
    expect(selectedProfileFromDecision(profiles, decision)).toEqual(profiles[1]);
  });
});

describe('routingBlockMessage', () => {
  it('formats message with estimated tokens', () => {
    const decision = {
      taskId: 'T1',
      estimatedTokens: 5000,
      contextLength: undefined,
      reason: 'too large',
    } as RoutingDecision;
    const message = routingBlockMessage(decision);
    expect(message).toContain('T1');
    expect(message).toContain('5000 estimated tokens');
  });

  it('formats message with context length ratio', () => {
    const decision = {
      taskId: 'T1',
      estimatedTokens: 5000,
      contextLength: 4000,
      reason: 'overflow',
    } as RoutingDecision;
    const message = routingBlockMessage(decision);
    expect(message).toContain('5000/4000 estimated tokens');
  });
});
