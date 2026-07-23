import { describe, expect, it } from 'vitest';
import { routingBlockMessage } from './routing.js';
import type { RoutingDecision } from '../context-routing/types.js';

describe('routingBlockMessage', () => {
  it('formats message with estimated tokens', () => {
    const decision = {
      taskId: 'T001',
      estimatedTokens: 5000,
      contextLength: undefined,
      reason: 'too large',
    } as RoutingDecision;
    const message = routingBlockMessage(decision);
    expect(message).toContain('T001');
    expect(message).toContain('5000 estimated tokens');
  });

  it('formats message with context length ratio', () => {
    const decision = {
      taskId: 'T001',
      estimatedTokens: 5000,
      contextLength: 4000,
      reason: 'overflow',
    } as RoutingDecision;
    const message = routingBlockMessage(decision);
    expect(message).toContain('5000/4000 estimated tokens');
  });
});
