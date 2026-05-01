import { describe, it, expect } from 'vitest';
import { ApprovalsStoreSchema } from './approval-store.js';

describe('ApprovalsStoreSchema', () => {
  it('parses empty grants array', () => {
    const result = ApprovalsStoreSchema.parse({ version: 1, grants: [] });
    expect(result.grants).toHaveLength(0);
  });

  it('throws when version is missing', () => {
    expect(() =>
      ApprovalsStoreSchema.parse({ grants: [] })
    ).toThrow();
  });

  it('throws on invalid class value', () => {
    expect(() =>
      ApprovalsStoreSchema.parse({
        version: 1,
        grants: [
          {
            pattern: 'src/**',
            class: 'invalid_class',
            scope: 'always',
            grantedAt: '2026-04-26T00:00:00.000Z',
          },
        ],
      })
    ).toThrow();
  });

  it('throws on invalid scope value', () => {
    expect(() =>
      ApprovalsStoreSchema.parse({
        version: 1,
        grants: [
          {
            pattern: 'src/**',
            class: 'read',
            scope: 'temporary',
            grantedAt: '2026-04-26T00:00:00.000Z',
          },
        ],
      })
    ).toThrow();
  });

});
