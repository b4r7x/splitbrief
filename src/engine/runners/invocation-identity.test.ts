import { describe, expect, it } from 'vitest';
import { InvocationIdentitySchema } from '../../core/schemas/invocation-identity.js';
import { snapshotCliInvocationIdentity } from './invocation-identity.js';

const NOW = 1_750_000_000_000;

describe('snapshotCliInvocationIdentity', () => {
  it.each(['claude-code', 'opencode'] as const)(
    'records a %s call with its runner and unknown billing only',
    (tool) => {
      const identity = snapshotCliInvocationIdentity({ tool, now: NOW });

      expect(identity).toStrictEqual({
        version: 1,
        capturedAt: NOW,
        runner: { kind: 'cli', id: tool },
      });
      expect(InvocationIdentitySchema.parse(identity)).toEqual(identity);
    },
  );
});
