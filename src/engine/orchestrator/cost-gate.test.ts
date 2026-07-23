import { describe, it, expect } from 'vitest';
import { makeCostPrediction } from '#testing/helpers/factories/cost-prediction.js';
import { decideCostGate } from './cost-gate.js';

describe('decideCostGate', () => {
  it('returns gate for standard mode with valid prediction', () => {
    expect(
      decideCostGate({ mode: 'standard', prediction: makeCostPrediction(), costGateEnabled: true }),
    ).toBe('gate');
  });
  it('returns gate for speckit mode', () => {
    expect(
      decideCostGate({ mode: 'speckit', prediction: makeCostPrediction(), costGateEnabled: true }),
    ).toBe('gate');
  });
  it('returns skip for instant mode', () => {
    expect(
      decideCostGate({ mode: 'instant', prediction: makeCostPrediction(), costGateEnabled: true }),
    ).toBe('skip');
  });
  it('returns skip for quick mode', () => {
    expect(
      decideCostGate({ mode: 'quick', prediction: makeCostPrediction(), costGateEnabled: true }),
    ).toBe('skip');
  });
  it('returns skip when costGateEnabled is false', () => {
    expect(
      decideCostGate({
        mode: 'standard',
        prediction: makeCostPrediction(),
        costGateEnabled: false,
      }),
    ).toBe('skip');
  });
  it('returns skip when prediction is null', () => {
    expect(decideCostGate({ mode: 'standard', prediction: null, costGateEnabled: true })).toBe(
      'skip',
    );
  });
  it('returns skip when deterministic is undefined', () => {
    expect(
      decideCostGate({
        mode: 'standard',
        prediction: makeCostPrediction({ deterministic: undefined }),
        costGateEnabled: true,
      }),
    ).toBe('skip');
  });
  it('returns skip-unknown-cost when knownActualEstimate is null', () => {
    const prediction = makeCostPrediction();
    prediction.deterministic!.totals.knownActualEstimate = null;
    expect(decideCostGate({ mode: 'standard', prediction, costGateEnabled: true })).toBe(
      'skip-unknown-cost',
    );
  });
});
