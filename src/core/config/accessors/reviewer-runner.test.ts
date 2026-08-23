import { describe, expect, it } from 'vitest';
import { configuredReviewerRunner, resolveReviewerRunner } from './reviewer-runner.js';
import { createDefaultConfig } from '../load/io.js';
import type { Config } from '../../schemas/config.js';
import type { ReviewerConfig } from '../../schemas/reviewer-config.js';

describe('resolveReviewerRunner', () => {
  it('falls back to the planner runner when no reviewer is configured', () => {
    const config = createDefaultConfig();

    expect(resolveReviewerRunner(config)).toEqual({
      runner: config.planner,
      source: 'planner',
    });
  });

  it('returns the configured reviewer runner when one is set', () => {
    const reviewer: ReviewerConfig = { kind: 'cli', tool: 'codex', model: 'gpt-5' };
    const config: Config = { ...createDefaultConfig(), reviewer };

    expect(resolveReviewerRunner(config)).toEqual({
      runner: reviewer,
      source: 'configured',
    });
  });
});

describe('configuredReviewerRunner', () => {
  it('returns undefined when the config is absent', () => {
    expect(configuredReviewerRunner(null)).toBeUndefined();
    expect(configuredReviewerRunner(undefined)).toBeUndefined();
  });
});
