import { describe, expect, it } from 'vitest';
import { seatFieldsOf, summaryBaseFromIdentity } from './seat-identity.js';

const BASE = { feature: 'feat', startTime: 1_000, projectDir: '/project', sessionId: 'sess-1' };

describe('summaryBaseFromIdentity', () => {
  it('puts each seat field with a value on the base and leaves out each field with no value', () => {
    // A record written before kinds and models were kept reads them as undefined.
    const summaryBase = summaryBaseFromIdentity(
      {
        plannerTool: 'claude-code',
        plannerModel: 'opus',
        plannerKind: undefined,
        plannerAxes: [],
        implementerTool: 'ollama',
        implementerModel: undefined,
        implementerKind: 'api',
        implementerAxes: undefined,
        reviewerTool: undefined,
        reviewerModel: undefined,
        reviewerKind: undefined,
        reviewerAxes: undefined,
        reviewerSeat: 'none',
      },
      BASE,
    );

    expect(summaryBase).toStrictEqual({
      ...BASE,
      plannerTool: 'claude-code',
      plannerModel: 'opus',
      plannerAxes: [],
      implementerTool: 'ollama',
      implementerKind: 'api',
      reviewerSeat: 'none',
    });
  });
});

describe('seatFieldsOf', () => {
  it('gives the seat fields the state keeps, with no axis words and no key for a field with no value', () => {
    const fields = seatFieldsOf({
      ...BASE,
      plannerTool: 'claude-code',
      plannerModel: 'opus',
      plannerKind: 'cli',
      plannerAxes: ['high'],
      implementerTool: 'ollama',
      implementerAxes: ['medium'],
      reviewerTool: 'codex',
      reviewerKind: 'cli',
      reviewerAxes: ['low'],
    });

    expect(fields).toStrictEqual({
      plannerTool: 'claude-code',
      plannerModel: 'opus',
      plannerKind: 'cli',
      implementerTool: 'ollama',
      reviewerTool: 'codex',
      reviewerKind: 'cli',
    });
  });
});
