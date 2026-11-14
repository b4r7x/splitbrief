import { describe, expect, it } from 'vitest';
import { describeOfferingBillingPresentation, resolveProviderRunMetadata } from './run-metadata.js';
import type { ProviderRunMetadata } from '../../../core/schemas/cost.js';
import { makeUsage } from '#testing/helpers/factories/summary.js';
import { breakdown } from '#testing/helpers/priced-breakdown.js';

describe('offering billing metadata', () => {
  it('meters PAYG when usage exists', () => {
    const metadata = resolveProviderRunMetadata({
      tool: 'custom-worker-api',
      normalizedEndpoint: 'https://api.worker.com/v1',
    });
    // A user-declared endpoint is metered per token, and carries no dated
    // catalog fact to stamp its identity with.
    expect(metadata).toMatchObject({
      service: 'custom-worker-api',
      offering: 'payg',
      billing: 'api-metered',
      normalizedEndpoint: 'https://api.worker.com/v1',
      asOf: '',
    });

    const presentation = describeOfferingBillingPresentation(metadata!, {
      hasUsage: true,
      meteredCost: 0.21,
    });
    expect(presentation.costLabel).toBe('$0.21');
    expect(presentation.billingLabel).toBe('api-metered');
  });

  it('claims no identity for a removed runner a resumed run still names', () => {
    for (const tool of ['aider', 'agent-sdk', 'openrouter', 'anthropic', 'shell']) {
      expect(resolveProviderRunMetadata({ tool })).toBeUndefined();
    }
  });

  it('labels subscription-included quota without a PAYG charge', () => {
    const metadata = resolveProviderRunMetadata({ tool: 'claude-code' });
    expect(metadata).toMatchObject({
      service: 'claude-code',
      offering: 'coding-subscription',
      billing: 'subscription-included',
      normalizedEndpoint: 'cli:claude',
      asOf: '2026-07-31',
    });

    const presentation = describeOfferingBillingPresentation(metadata!, {
      hasUsage: true,
      meteredCost: 0,
    });
    expect(presentation.costLabel).toBe('subscription-included');
    expect(presentation.billingLabel).toBe('subscription-included');
    expect(presentation.costLabel).not.toMatch(/\$0 extra|free|local/i);
  });

  it('describes free quota as variable', () => {
    const metadata: ProviderRunMetadata = {
      service: 'gemini',
      offering: 'free-quota',
      normalizedEndpoint: 'https://generativelanguage.googleapis.com/v1beta/openai',
      billing: 'provider-dependent',
      asOf: '2026-07-31',
    };

    const presentation = describeOfferingBillingPresentation(metadata, { hasUsage: true });
    expect(presentation.costLabel).toBe('variable quota');
    expect(presentation.costLabel).not.toMatch(/free|unlimited|guaranteed/i);
  });

  it('labels local compute local', () => {
    const metadata = resolveProviderRunMetadata({
      tool: 'ollama',
      normalizedEndpoint: 'http://localhost:11434/v1',
    });
    expect(metadata).toMatchObject({
      service: 'ollama',
      offering: 'local',
      billing: 'local',
      normalizedEndpoint: 'http://localhost:11434/v1',
      asOf: '2026-07-31',
    });

    const presentation = describeOfferingBillingPresentation(metadata!, { hasUsage: true });
    expect(presentation.costLabel).toBe('local');
    expect(presentation.billingLabel).toBe('local');
  });

  it('carries offering metadata through calculateCostBreakdown', () => {
    const usage = makeUsage({
      plannerInput: 100_000,
      plannerOutput: 50_000,
      implementerInput: 500_000,
      implementerOutput: 200_000,
    });

    const result = breakdown({
      tokenUsage: usage,
      plannerTool: 'custom-planner-api',
      plannerModel: 'claude-sonnet-5',
      implementerTool: 'ollama',
      implementerModel: 'qwen-local',
    });

    expect(result.providerRunMetadata?.['custom-planner-api']).toMatchObject({
      service: 'custom-planner-api',
      offering: 'payg',
      billing: 'api-metered',
      asOf: '',
    });
    expect(result.providerRunMetadata?.ollama).toMatchObject({
      service: 'ollama',
      offering: 'local',
      billing: 'local',
      asOf: '2026-07-31',
    });
    expect(result.offeringPresentations?.['custom-planner-api']?.costLabel).toMatch(/^\$/);
    expect(result.offeringPresentations?.ollama?.costLabel).toBe('local');
  });
});
