import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushEffects, renderFeature, tick } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { forceUnicodeGlyphs } from '#testing/helpers/glyphs.js';
import { overlayRect } from '../../core/navigation/overlay-rect.js';
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

/** One unpriced Antigravity request: the rate row reads `<model> · no published rate · 1 request`. */
function unpricedRun(model: string): UsageDetailsView {
  return deriveUsageDetails({
    tokenUsage: { ...ZERO_TOKEN_USAGE, reviewerInput: 2_100 },
    costBreakdown: {
      actualPlannerCost: 0,
      actualImplementerCost: 0,
      totalActualCost: 0,
      hasUnpricedUsage: true,
      requestEstimate: {
        amount: null,
        currency: 'USD',
        basis: 'unavailable',
        completeness: 'unavailable',
        knownSubtotal: 0,
        reasons: ['unpriced-model'],
        items: [
          {
            callId: 'call-review-1',
            role: 'review',
            usageBoundary: 'single-request',
            amount: null,
            knownSubtotal: 0,
            completeness: 'unavailable',
            reasons: ['unpriced-model'],
            billing: { posture: 'unknown', basis: 'unknown' },
            rates: {
              source: 'unpriced',
              provider: 'antigravity',
              model,
              inputPer1M: 0,
              outputPer1M: 0,
              capturedAt: 1_700_000_000_000,
            },
          },
        ],
      },
      providerRunMetadata: {
        'cli:antigravity': {
          service: 'antigravity',
          offering: 'coding-subscription',
          normalizedEndpoint: 'cli:antigravity',
          billing: 'unknown',
          asOf: '',
          billingAttribution: { posture: 'unknown', basis: 'unknown' },
        },
      },
    },
  });
}

async function renderLines(view: UsageDetailsView): Promise<string[]> {
  const ui = renderFeature(<UsageDetails view={view} onClose={() => {}} />, {
    cols: 120,
    rows: 40,
  });
  await tick(20);
  const lines = (ui.lastFrame() ?? '').split('\n');
  ui.unmount();
  return lines;
}

/** The cells a rate row's value column holds, measured on the painted Antigravity rate row. */
async function rateValueColumn(): Promise<{ labelCol: number; valueCol: number; width: number }> {
  const lines = await renderLines(unpricedRun('probe'));
  const row = lines.find((line) => line.includes('antigravity ')) ?? '';
  const labelCol = row.indexOf('antigravity');
  const valueCol = row.indexOf('probe');
  const { innerWidth } = overlayRect({ cols: 120, rows: 40, density: 'wide' });
  return { labelCol, valueCol, width: innerWidth - (valueCol - labelCol) };
}

describe('UsageDetails rows', () => {
  beforeEach(() => {
    forceUnicodeGlyphs();
    resetAllStores();
    terminalSizeStore.__testReset({ cols: 120, rows: 40, isSmall: false });
  });

  it('names a tool with a long name in full when the panel has room for it', async () => {
    const lines = await renderLines(unpricedRun('gemini-3-pro'));

    expect(lines.join('\n')).toContain(
      'Google Antigravity CLI  unknown · no evidence, tool default',
    );
    expect(lines.join('\n')).not.toContain('…');
  });

  it('packs a rate row that overruns by one column into two lines, not one per fact', async () => {
    const { labelCol, valueCol, width } = await rateValueColumn();
    // `<model> · no published rate · 1 request` is the model plus 32 cells: one cell too many.
    const model = 'm'.repeat(width - 31);
    const lines = await renderLines(unpricedRun(model));
    const index = lines.findIndex((line) => line.includes('antigravity '));

    expect(lines[index]?.slice(valueCol).trimEnd()).toMatch(
      new RegExp(`^${model} · no published rate +│$`),
    );
    expect(lines[index + 1]?.slice(labelCol, valueCol).trim()).toBe('');
    expect(lines[index + 1]?.slice(valueCol).trimEnd()).toMatch(/^1 request +│$/);
    expect(lines[index + 2]?.slice(labelCol).trimEnd()).toMatch(/^ +│$/);
  });

  it('hard-wraps only a fact wider than the column and keeps packing after it', async () => {
    const { valueCol, width } = await rateValueColumn();
    const model = 'm'.repeat(width + 5);
    const lines = await renderLines(unpricedRun(model));
    const index = lines.findIndex((line) => line.includes('antigravity '));

    expect(lines[index]?.slice(valueCol, valueCol + width)).toBe('m'.repeat(width));
    expect(lines[index + 1]?.slice(valueCol).trimEnd()).toMatch(
      /^m{5} · no published rate · 1 request +│$/,
    );
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
  details: ['Pick a review seat with a larger context in /crew review, then choose Try again.'],
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
  availableActions: ['retry-same-worker', 'end-run'],
  recommendedAction: 'retry-same-worker',
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
