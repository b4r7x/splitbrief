import { describe, it, expect } from 'vitest';
import { SummarySchema } from './summary.js';
import { makeSummary } from '#testing/helpers/factories/summary.js';

describe('SummarySchema seat identity kinds', () => {
  it('keeps the persisted seat kinds beside their tools through a round trip', () => {
    const parsed = SummarySchema.parse(
      makeSummary({
        plannerTool: 'claude-code',
        plannerKind: 'cli',
        implementerTool: 'opencode',
        implementerKind: 'api',
        reviewerTool: 'codex',
        reviewerKind: 'cli',
      }),
    );

    expect(parsed).toMatchObject({
      plannerKind: 'cli',
      implementerKind: 'api',
      reviewerKind: 'cli',
    });
  });

  it('keeps the axis words each seat ran at through a round trip', () => {
    const parsed = SummarySchema.parse(
      makeSummary({
        plannerTool: 'claude-code',
        plannerAxes: ['high'],
        implementerTool: 'codex',
        implementerAxes: ['low'],
        reviewerTool: 'opencode',
        reviewerAxes: [],
      }),
    );

    expect(parsed).toMatchObject({
      plannerAxes: ['high'],
      implementerAxes: ['low'],
      reviewerAxes: [],
    });
  });

  it('reads a legacy summary with no kinds as unknown, never as a default kind', () => {
    const parsed = SummarySchema.parse(
      makeSummary({ plannerTool: 'claude-code', implementerTool: 'opencode' }),
    );

    expect(parsed).not.toHaveProperty('plannerKind');
    expect(parsed).not.toHaveProperty('implementerKind');
    expect(parsed).not.toHaveProperty('reviewerKind');
    expect(parsed).not.toHaveProperty('plannerAxes');
    expect(parsed).not.toHaveProperty('implementerAxes');
  });

  it('rejects a persisted kind outside the runner kinds', () => {
    expect(() => SummarySchema.parse({ ...makeSummary(), plannerKind: 'local' })).toThrow();
  });
});
