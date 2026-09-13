import { describe, expect, it } from 'vitest';
import { SessionSchema } from './session.js';

const base = {
  id: 'sess_1',
  feature: 'add a health route',
  startedAt: 1_700_000_000_000,
  completedAt: 1_700_000_060_000,
  stateVersion: 4,
};

describe('SessionSchema', () => {
  it('parses a cancelled session', () => {
    const result = SessionSchema.safeParse({ ...base, status: 'cancelled', summary: null });
    expect(result.success).toBe(true);
  });

  it('rejects a status outside the union', () => {
    expect(SessionSchema.safeParse({ ...base, status: 'stopped', summary: null }).success).toBe(
      false,
    );
  });
});
