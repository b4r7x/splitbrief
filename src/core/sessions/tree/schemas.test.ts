import { describe, it, expect } from 'vitest';
import {
  entryId,
  nextEntryId,
  EntryIdSchema,
  TreeEntryEnvelopeSchema,
  TreeMetaSchema,
} from './schemas.js';

describe('entryId', () => {
  it('creates a branded EntryId from a string', () => {
    const id = entryId('E0001');
    expect(EntryIdSchema.safeParse(id).success).toBe(true);
  });

  it('rejects non-string values', () => {
    expect(EntryIdSchema.safeParse(123).success).toBe(false);
    expect(EntryIdSchema.safeParse(null).success).toBe(false);
    expect(EntryIdSchema.safeParse(undefined).success).toBe(false);
  });
});

describe('TreeEntryEnvelopeSchema', () => {
  it('accepts a valid envelope', () => {
    const envelope = {
      id: entryId('E0001'),
      parentId: null,
      type: 'session-start',
      timestamp: 1000,
      payload: null,
    };
    const result = TreeEntryEnvelopeSchema.safeParse(envelope);
    expect(result.success).toBe(true);
  });

  it('accepts an envelope with display property', () => {
    const envelope = {
      id: entryId('E0002'),
      parentId: entryId('E0001'),
      type: 'message',
      timestamp: 2000,
      payload: { text: 'hello' },
      display: true,
    };
    const result = TreeEntryEnvelopeSchema.safeParse(envelope);
    expect(result.success).toBe(true);
  });

  it('rejects an envelope missing required fields', () => {
    const envelope = {
      id: entryId('E0001'),
      type: 'session-start',
      timestamp: 1000,
    };
    const result = TreeEntryEnvelopeSchema.safeParse(envelope);
    expect(result.success).toBe(false);
  });

  it('accepts an envelope with plain string id at runtime (brand is type-only)', () => {
    const envelope = {
      id: 'E0001',
      parentId: null,
      type: 'session-start',
      timestamp: 1000,
      payload: null,
    };
    const result = TreeEntryEnvelopeSchema.safeParse(envelope);
    expect(result.success).toBe(true);
  });
});

describe('TreeMetaSchema', () => {
  it('accepts valid meta', () => {
    const meta = {
      leafId: entryId('E0003'),
      entryCount: 3,
      branchCount: 1,
      createdAt: 1000,
      updatedAt: 3000,
    };
    const result = TreeMetaSchema.safeParse(meta);
    expect(result.success).toBe(true);
  });

  it('rejects negative entryCount', () => {
    const meta = {
      leafId: entryId('E0001'),
      entryCount: -1,
      branchCount: 0,
      createdAt: 1000,
      updatedAt: 1000,
    };
    const result = TreeMetaSchema.safeParse(meta);
    expect(result.success).toBe(false);
  });

  it('rejects negative branchCount', () => {
    const meta = {
      leafId: entryId('E0001'),
      entryCount: 1,
      branchCount: -1,
      createdAt: 1000,
      updatedAt: 1000,
    };
    const result = TreeMetaSchema.safeParse(meta);
    expect(result.success).toBe(false);
  });

  it('rejects non-integer counts', () => {
    const meta = {
      leafId: entryId('E0001'),
      entryCount: 1.5,
      branchCount: 0,
      createdAt: 1000,
      updatedAt: 1000,
    };
    const result = TreeMetaSchema.safeParse(meta);
    expect(result.success).toBe(false);
  });
});

describe('nextEntryId', () => {
  it('generates E0001 for count 0', () => {
    expect(nextEntryId(0)).toBe(entryId('E0001'));
  });

  it('generates E0002 for count 1', () => {
    expect(nextEntryId(1)).toBe(entryId('E0002'));
  });

  it('pads to 4 digits', () => {
    expect(nextEntryId(9)).toBe(entryId('E0010'));
    expect(nextEntryId(99)).toBe(entryId('E0100'));
    expect(nextEntryId(999)).toBe(entryId('E1000'));
  });
});
