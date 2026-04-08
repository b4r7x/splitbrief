import { describe, it, expect, beforeEach } from 'vitest';
import { routerStore } from './router.js';
import type { Summary } from '../types.js';

const dummySummary: Summary = {
  feature: 'test',
  totalTasks: 1,
  completedByLocal: 1,
  escalatedToPlanner: 0,
  skipped: 0,
  failed: 0,
  totalTime: 1000,
  tokenUsage: { plannerInput: 0, plannerOutput: 0, implementerInput: 0, implementerOutput: 0, escalationInput: 0, escalationOutput: 0 },
  estimatedCostSavings: '$0.00',
  escalationRate: 0,
};

describe('routerStore', () => {
  beforeEach(() => routerStore.reset());

  it('navigates home → workflow', () => {
    routerStore.navigate('workflow', { feature: 'auth' });
    const s = routerStore.get();
    expect(s.screen).toBe('workflow');
    if (s.screen === 'workflow') expect(s.feature).toBe('auth');
  });

  it('navigates workflow → summary', () => {
    routerStore.navigate('workflow', { feature: 'x' });
    routerStore.navigate('summary', { summary: dummySummary });
    const s = routerStore.get();
    expect(s.screen).toBe('summary');
    if (s.screen === 'summary') expect(s.summary).toBe(dummySummary);
  });

  it('navigates summary → home', () => {
    routerStore.navigate('workflow', { feature: 'x' });
    routerStore.navigate('summary', { summary: dummySummary });
    routerStore.navigate('home');
    expect(routerStore.get().screen).toBe('home');
  });

  it('throws on invalid transition home → summary', () => {
    expect(() => routerStore.navigate('summary', { summary: dummySummary }))
      .toThrow(/Cannot navigate from "home" to "summary"/);
  });

  it('throws when summary data missing', () => {
    routerStore.navigate('workflow', { feature: 'x' });
    expect(() => routerStore.navigate('summary'))
      .toThrow(/Summary data required/);
  });

  it('init sets arbitrary route', () => {
    routerStore.init({ screen: 'workflow', feature: 'resume' });
    expect(routerStore.get().screen).toBe('workflow');
  });
});
