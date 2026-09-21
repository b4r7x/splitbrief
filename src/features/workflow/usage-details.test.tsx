import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushEffects, renderFeature, tick } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { forceUnicodeGlyphs } from '#testing/helpers/glyphs.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import type { RecoveryIssue } from '../../core/schemas/recovery/schemas.js';
import { ZERO_TOKEN_USAGE } from '../../core/schemas/tokens.js';
import { deriveUsageDetails, type UsageDetailsView } from './usage-details-model.js';
import { UsageDetails } from './usage-details.js';

const ESCAPE = '\u001b';

/** A run whose planner reported input and output, and whose cache and reasoning were never sent. */
const partiallyReportedRun: UsageDetailsView = deriveUsageDetails({
  tokenUsage: {
    ...ZERO_TOKEN_USAGE,
    plannerInput: 12_400,
    plannerOutput: 3_200,
    plannerCoverage: {
      input: 'reported',
      output: 'reported',
      cacheRead: 'missing',
      cacheCreate: 'missing',
      reasoning: 'missing',
    },
  },
  costBreakdown: {
    actualPlannerCost: 0.42,
    actualImplementerCost: 0,
    totalActualCost: 0.42,
    hasPricedUsage: true,
    requestEstimate: {
      amount: 0.42,
      currency: 'USD',
      basis: 'catalog-estimate',
      completeness: 'partial',
      knownSubtotal: 0.42,
      reasons: ['reasoning-not-reported'],
      items: [
        {
          callId: 'call-1',
          role: 'planner',
          usageBoundary: 'single-request',
          amount: 0.42,
          knownSubtotal: 0.42,
          completeness: 'partial',
          reasons: ['reasoning-not-reported'],
          billing: { posture: 'api-metered', basis: 'enforced-channel' },
          rates: {
            source: 'models-dev',
            provider: 'anthropic',
            model: 'claude-opus',
            inputPer1M: 5,
            outputPer1M: 25,
            capturedAt: 1_700_000_000_000,
          },
        },
      ],
    },
    providerRunMetadata: {
      'claude-code': {
        service: 'claude-code',
        offering: 'payg',
        normalizedEndpoint: 'cli://claude-code',
        billing: 'api-metered',
        asOf: '2026-01-01',
        billingAttribution: {
          posture: 'api-metered',
          basis: 'enforced-channel',
          evidenceId: 'cli.claude-code.api-key',
        },
      },
    },
  },
});

describe('UsageDetails', () => {
  beforeEach(() => {
    forceUnicodeGlyphs();
    resetAllStores();
    terminalSizeStore.__testReset({ cols: 120, rows: 40, isSmall: false });
  });

  it('names what was reported, what was not, and calls the money an estimate', async () => {
    const ui = renderFeature(<UsageDetails view={partiallyReportedRun} onClose={() => {}} />, {
      cols: 120,
      rows: 40,
    });
    await tick(20);
    const frame = ui.lastFrame();

    expect(frame).toContain('Usage details');
    expect(frame).toContain('12,400');
    expect(frame).toContain('not reported');
    expect(frame).toContain('$0.42');
    expect(frame).toContain('catalog estimate');
    expect(frame).toContain('claude-opus · models.dev');
    expect(frame).toContain('metered · enforced channel');
    expect(frame).toContain('esc close');
    expect(frame).not.toMatch(/invoice|actual charge|billed/i);
    expect(frame).not.toContain('$0.00');
    ui.unmount();
  });

  it('says a session with nothing recorded has nothing to show', async () => {
    const ui = renderFeature(
      <UsageDetails
        view={deriveUsageDetails({ tokenUsage: null, costBreakdown: null })}
        onClose={() => {}}
      />,
      { cols: 80, rows: 24 },
    );
    await tick(20);

    expect(ui.lastFrame()).toContain('No usage recorded');
    ui.unmount();
  });

  it('closes on escape and leaves the run alone', async () => {
    const closed: number[] = [];
    const ui = renderFeature(
      <UsageDetails view={partiallyReportedRun} onClose={() => closed.push(1)} />,
      { cols: 80, rows: 24 },
    );
    await flushEffects();

    ui.stdin.write(ESCAPE);
    await vi.waitFor(() => expect(closed).toEqual([1]));
    ui.unmount();
  });
});

const contextHalt: RecoveryIssue = {
  id: 'rec_visual_context',
  reason: 'review-failed',
  seat: 'review',
  phase: 'final-review',
  status: 'awaiting-user',
  files: [],
  affectedTaskIds: [],
  message: 'The review seat was not given the context this call needs.',
  details: ['Adjust the review seat with /crew review or Settings, then /resume and choose retry.'],
  facts: {
    apiContextCode: 'insufficient-context',
    apiContextSeat: 'review',
    apiContextCause: 'input-budget',
    apiContextModel: 'qwen3-coder-30b',
    apiContextMissingSectionsJson: '["evidence.json"]',
    apiContextInputEstimate: 404_000,
    apiContextEstimationMargin: 4_000,
    apiContextRequiredOutputTokens: 4_096,
    apiContextRequiredTokens: 412_096,
    apiContextAvailableTokens: 32_768,
    apiContextOutputCap: 8_192,
  },
  availableActions: ['retry-same-worker', 'pause-run', 'end-run'],
  recommendedAction: 'pause-run',
  createdAt: '2026-04-29T12:00:00.000Z',
};

describe('UsageDetails context section', () => {
  beforeEach(() => {
    forceUnicodeGlyphs();
    resetAllStores();
    terminalSizeStore.__testReset({ cols: 120, rows: 40, isSmall: false });
  });

  it('opens on what the halt needed and what the seat had', async () => {
    const ui = renderFeature(
      <UsageDetails
        view={deriveUsageDetails({
          tokenUsage: { ...ZERO_TOKEN_USAGE, reviewerInput: 2_100 },
          costBreakdown: null,
          recovery: contextHalt,
        })}
        onClose={() => {}}
      />,
      { cols: 120, rows: 40 },
    );
    await tick(20);
    const frame = ui.lastFrame();

    expect(frame).toContain('Context');
    expect(frame).toContain('REVIEW');
    expect(frame).toContain('qwen3-coder-30b');
    expect(frame).toContain('larger than the context window');
    expect(frame).toContain('evidence.json');
    expect(frame).toContain('412,096 tokens · input 404,000 · margin 4,000 · output reserve 4,096');
    expect(frame).toContain('32,768 tokens · output cap 8,192');
    expect(frame).toContain('Nothing was sent to the seat · measured while the call was assembled');
    expect(frame).not.toMatch(/invoice|actual charge|billed/i);
    expect(frame).not.toContain('$0.00');
    ui.unmount();
  });

  it('says what a halt never measured, and closes on escape without touching the run', async () => {
    const closed: number[] = [];
    const ui = renderFeature(
      <UsageDetails
        view={deriveUsageDetails({
          tokenUsage: null,
          costBreakdown: null,
          recovery: {
            ...contextHalt,
            seat: 'plan',
            facts: {
              apiContextCode: 'insufficient-context',
              apiContextSeat: 'plan',
              apiContextCause: 'missing-required',
            },
          },
        })}
        onClose={() => closed.push(1)}
      />,
      { cols: 80, rows: 24 },
    );
    await flushEffects();

    const frame = ui.lastFrame();
    expect(frame).toContain('PLAN');
    expect(frame).toContain('required evidence was missing');
    expect(frame).toContain('not recorded');
    expect(frame).toContain('not measured');
    expect(frame).not.toContain('No usage recorded');

    ui.stdin.write(ESCAPE);
    await vi.waitFor(() => expect(closed).toEqual([1]));
    ui.unmount();
  });
});
