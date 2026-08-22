import { describe, expect, it } from 'vitest';
import { configuredReviewerSeat } from './reviewer-seat.js';
import { createDefaultConfig } from '../load/io.js';
import type { Config } from '../../schemas/config.js';
import type { ReviewerConfig } from '../../schemas/reviewer-config.js';

describe('configuredReviewerSeat', () => {
  it('has no seat when the planner holds the review seat', () => {
    expect(configuredReviewerSeat(createDefaultConfig())).toBeUndefined();
  });

  it('reports the configured reviewer display name and model', () => {
    const reviewer: ReviewerConfig = { kind: 'cli', tool: 'codex', model: 'gpt-5' };
    const config: Config = { ...createDefaultConfig(), reviewer };

    expect(configuredReviewerSeat(config)).toEqual({ tool: 'codex', model: 'gpt-5' });
  });

  it('omits the model when the reviewer does not resolve one', () => {
    const reviewer: ReviewerConfig = { kind: 'cli', tool: 'codex' };
    const config: Config = { ...createDefaultConfig(), reviewer };

    expect(configuredReviewerSeat(config)).not.toHaveProperty('model');
  });
});
