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
  it('parses the three run statuses', () => {
    for (const status of ['open', 'ended'] as const) {
      expect(SessionSchema.safeParse({ ...base, status, summary: null }).success).toBe(true);
    }
  });

  it('requires a summary on a complete session', () => {
    expect(SessionSchema.safeParse({ ...base, status: 'complete', summary: null }).success).toBe(
      false,
    );
  });

  it.each(['interrupted', 'cancelled'] as const)('maps the legacy %s status to open', (status) => {
    const result = SessionSchema.safeParse({ ...base, status, summary: null });
    expect(result.success && result.data.status).toBe('open');
    expect(result.success && result.data.stop).toBeUndefined();
  });

  it('maps the legacy failed status to open with a failed stop reason', () => {
    const result = SessionSchema.safeParse({ ...base, status: 'failed', summary: null });
    expect(result.success && result.data.status).toBe('open');
    expect(result.success && result.data.stop).toBe('failed');
  });

  it('carries the phase, mode and stop reason of an open run', () => {
    const result = SessionSchema.safeParse({
      ...base,
      status: 'open',
      summary: null,
      phase: 'implementing',
      mode: 'standard',
      stop: 'halted',
    });
    expect(result.success && result.data).toMatchObject({
      phase: 'implementing',
      mode: 'standard',
      stop: 'halted',
    });
  });

  it('rejects a status outside the union', () => {
    expect(SessionSchema.safeParse({ ...base, status: 'stopped', summary: null }).success).toBe(
      false,
    );
  });
});
