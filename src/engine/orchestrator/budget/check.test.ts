import { describe, it, expect } from 'vitest';
import { checkBudget } from './check.js';

describe('checkBudget', () => {
  it.each<[string, number, number, number | undefined, ReturnType<typeof checkBudget>]>([
    ['cost below 80%', 0.5, 1.0, undefined, { action: 'ok' }],
    ['cost at exactly 79%', 0.79, 1.0, undefined, { action: 'ok' }],
    ['NaN currentCost (safe default)', NaN, 1.0, undefined, { action: 'ok' }],
    ['negative currentCost', -0.5, 1.0, undefined, { action: 'ok' }],
  ])('ok — %s', (_label, cost, budget, pause, expected) => {
    expect(checkBudget(cost, budget, pause)).toEqual(expected);
  });

  it.each<[string, number, number, number | undefined, ReturnType<typeof checkBudget>]>([
    ['at 80% threshold', 0.8, 1.0, undefined, { action: 'warning' }],
    ['between 80% and 85%', 0.82, 1.0, undefined, { action: 'warning' }],
    ['at 85% with custom pauseThreshold 90%', 0.85, 1.0, 0.9, { action: 'warning' }],
  ])('warning — %s', (_label, cost, budget, pause, expected) => {
    expect(checkBudget(cost, budget, pause)).toEqual(expected);
  });

  it.each<[string, number, number, number | undefined, ReturnType<typeof checkBudget>]>([
    ['at exactly 85%', 0.85, 1.0, undefined, { action: 'paused' }],
    ['between 85% and 100%', 0.95, 1.0, undefined, { action: 'paused' }],
    ['at custom pauseThreshold 90%', 0.9, 1.0, 0.9, { action: 'paused' }],
  ])('paused — %s', (_label, cost, budget, pause, expected) => {
    expect(checkBudget(cost, budget, pause)).toEqual(expected);
  });

  it.each<[string, number, number, number | undefined, ReturnType<typeof checkBudget>]>([
    ['at 100%', 1.0, 1.0, undefined, { action: 'exceeded', shouldStop: true }],
    ['over 100%', 1.5, 1.0, undefined, { action: 'exceeded', shouldStop: true }],
    ['NaN budget', 0, NaN, undefined, { action: 'exceeded', shouldStop: true }],
    ['zero budget', 0, 0, undefined, { action: 'exceeded', shouldStop: true }],
    ['negative budget', 0, -1, undefined, { action: 'exceeded', shouldStop: true }],
    ['Infinity budget', 0, Infinity, undefined, { action: 'exceeded', shouldStop: true }],
    ['Infinity currentCost', Infinity, 1.0, undefined, { action: 'exceeded', shouldStop: true }],
    [
      'negative Infinity currentCost',
      -Infinity,
      1.0,
      undefined,
      { action: 'exceeded', shouldStop: true },
    ],
  ])('exceeded — %s', (_label, cost, budget, pause, expected) => {
    expect(checkBudget(cost, budget, pause)).toEqual(expected);
  });
});
