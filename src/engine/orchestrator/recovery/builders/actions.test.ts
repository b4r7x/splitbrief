import { describe, expect, it } from 'vitest';
import { chooseRecommended, haltActions } from './actions.js';

describe('haltActions', () => {
  it('lists the actions in the order every halt lists them and drops the ones left out', () => {
    expect(
      haltActions('runner-usage-limit', ['end-run', undefined, 'retry-same-worker', 'switch-seat']),
    ).toEqual(['retry-same-worker', 'switch-seat', 'end-run']);
  });
});

describe('chooseRecommended', () => {
  it('takes the first preference the issue offers', () => {
    expect(
      chooseRecommended(['retry-same-worker', 'switch-seat', 'end-run'], ['switch-seat']),
    ).toBe('switch-seat');
  });

  it('takes the first action listed when no preference is offered', () => {
    expect(chooseRecommended(['retry-same-worker', 'end-run'], ['switch-seat'])).toBe(
      'retry-same-worker',
    );
    expect(chooseRecommended(['skip-current-task', 'end-run'])).toBe('skip-current-task');
  });
});
