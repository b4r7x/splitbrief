import { describe, it, expect, beforeEach } from 'vitest';
import { routerStore } from './router.js';
import { feedbackStore } from '../ui/feedback.js';
import type { Summary } from '../../core/schemas/summary.js';

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
  beforeEach(() => {
    routerStore.reset();
    feedbackStore.reset();
  });

  it('navigates home → workflow', () => {
    routerStore.navigate({ to: 'workflow', feature: 'auth' });
    const s = routerStore.get();
    expect(s.screen).toBe('workflow');
    if (s.screen === 'workflow') expect(s.feature).toBe('auth');
  });

  it('navigates workflow → summary', () => {
    routerStore.navigate({ to: 'workflow', feature: 'x' });
    routerStore.navigate({ to: 'summary', summary: dummySummary });
    const s = routerStore.get();
    expect(s.screen).toBe('summary');
    if (s.screen === 'summary') expect(s.summary).toBe(dummySummary);
  });

  it('navigates summary → home', () => {
    routerStore.navigate({ to: 'workflow', feature: 'x' });
    routerStore.navigate({ to: 'summary', summary: dummySummary });
    routerStore.navigate({ to: 'home' });
    expect(routerStore.get().screen).toBe('home');
  });

  it('reports error and stays put on invalid transition home → summary', () => {
    routerStore.navigate({ to: 'summary', summary: dummySummary });
    expect(routerStore.get().screen).toBe('home');
    expect(feedbackStore.get().isError).toBe(true);
    expect(feedbackStore.get().message).toMatch(/Cannot navigate from "home" to "summary"/);
  });

  it('init sets arbitrary route', () => {
    routerStore.init({ screen: 'workflow', feature: 'resume' });
    expect(routerStore.get().screen).toBe('workflow');
  });
});
