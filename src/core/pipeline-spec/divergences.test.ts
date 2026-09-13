import { describe, expect, it } from 'vitest';
import { DIVERGENCE_TABLE } from './divergences.js';

describe('divergence table', () => {
  it('carries the fourteen decided rows of recon-parity §4', () => {
    expect(DIVERGENCE_TABLE.length).toBe(14);
  });

  it('exactly one row is intentional', () => {
    const intentional = DIVERGENCE_TABLE.filter((row) => row.owner === 'intentional');
    expect(intentional).toEqual([
      {
        behaviour: 'Default mode and where the implementer writes',
        owner: 'intentional',
        req: 'REQ-042',
      },
    ]);
  });

  it('gives every row a distinct behaviour and a REQ id', () => {
    expect(new Set(DIVERGENCE_TABLE.map((row) => row.behaviour)).size).toBe(
      DIVERGENCE_TABLE.length,
    );
    for (const row of DIVERGENCE_TABLE) {
      expect(row.req).toMatch(/^REQ-\d{3}$/);
    }
  });
});
