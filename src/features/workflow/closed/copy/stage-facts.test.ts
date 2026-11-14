import { describe, expect, it } from 'vitest';
import type { BriefRow } from '../view-model.js';
import { taskId } from '../../../../core/schemas/task.js';
import { briefRowParts } from './stage-facts.js';

describe('briefRowParts', () => {
  function row(overrides: Partial<BriefRow> = {}): BriefRow {
    return {
      id: taskId('T001'),
      title: 'Add validator module',
      state: 'local',
      method: 'local',
      retries: 0,
      durationMs: 84_200,
      file: 'src/validate.ts',
      partialFiles: 0,
      ...overrides,
    };
  }

  it('hands a settled brief its method, file and clock', () => {
    expect(briefRowParts({ row: row() })).toEqual({
      id: taskId('T001'),
      title: 'Add validator module',
      state: { kind: 'settled', method: 'local' },
      duration: 84_200,
      file: 'src/validate.ts',
    });
  });

  it('carries retries only when the brief needed them', () => {
    expect(briefRowParts({ row: row({ retries: 2 }) }).retries).toBe(2);
    expect(briefRowParts({ row: row() }).retries).toBeUndefined();
  });

  it('gives a pending brief nothing to say', () => {
    const parts = briefRowParts({
      row: row({ state: 'pending', method: null, durationMs: null, file: null }),
    });
    expect(parts.state).toEqual({ kind: 'pending' });
    expect(parts.duration).toBeUndefined();
  });

  it('says the brief the run stopped inside was stopped, and counts what it half wrote', () => {
    const parts = briefRowParts({
      row: row({ state: 'stopped', method: null, durationMs: null, partialFiles: 2 }),
    });
    expect(parts.state).toEqual({ kind: 'halted', tone: 'cancelled', word: 'stopped' });
    expect(parts.note).toBe('2 partial files');
  });

  it('leaves the note off a halted brief that wrote nothing', () => {
    const parts = briefRowParts({ row: row({ state: 'stopped', method: null, partialFiles: 0 }) });
    expect(parts.note).toBeUndefined();
  });

  it('gives a brief with no recorded method the one its state implies', () => {
    expect(briefRowParts({ row: row({ state: 'escalated', method: null }) }).state).toEqual({
      kind: 'settled',
      method: 'escalated-full',
    });
    expect(briefRowParts({ row: row({ state: 'skipped', method: null }) }).state).toEqual({
      kind: 'settled',
      method: 'skipped',
    });
    expect(briefRowParts({ row: row({ state: 'failed', method: null }) }).state).toEqual({
      kind: 'settled',
      method: 'failed',
    });
  });

  it('keeps the exact method a brief escalated with', () => {
    expect(
      briefRowParts({ row: row({ state: 'escalated', method: 'escalated-hint' }) }).state,
    ).toEqual({ kind: 'settled', method: 'escalated-hint' });
  });
});
