import { describe, expect, it } from 'vitest';
import { endedInBuild, endedInPlanning } from '#testing/helpers/factories/summary-view.js';
import { filesRows } from './change-facts.js';

describe('filesRows', () => {
  it('marks the files the stopped brief left half written', () => {
    expect(filesRows(endedInBuild())).toEqual([
      { path: 'src/routes/signup.ts', partial: true },
      { path: 'src/validate.ts', partial: false },
    ]);
  });

  it('is empty when no changed set was recorded', () => {
    expect(filesRows(endedInPlanning())).toEqual([]);
  });
});
