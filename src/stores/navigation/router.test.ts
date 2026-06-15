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
  tokenUsage: {
    plannerInput: 0,
    plannerOutput: 0,
    implementerInput: 0,
    implementerOutput: 0,
    escalationInput: 0,
    escalationOutput: 0,
  },
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
    routerStore.navigate({ to: 'summary', summary: dummySummary, status: 'complete' });
    const s = routerStore.get();
    expect(s.screen).toBe('summary');
    if (s.screen === 'summary') expect(s.summary).toBe(dummySummary);
  });

  it('navigates summary → home', () => {
    routerStore.navigate({ to: 'workflow', feature: 'x' });
    routerStore.navigate({ to: 'summary', summary: dummySummary, status: 'complete' });
    routerStore.navigate({ to: 'home' });
    expect(routerStore.get().screen).toBe('home');
  });

  it('navigates home → summary', () => {
    routerStore.navigate({ to: 'summary', summary: dummySummary, status: 'complete' });
    const s = routerStore.get();
    expect(s.screen).toBe('summary');
    if (s.screen === 'summary') expect(s.summary).toBe(dummySummary);
  });

  it('navigates setup → summary', () => {
    routerStore.navigate({ to: 'setup' });
    routerStore.navigate({ to: 'summary', summary: dummySummary, status: 'complete' });
    const s = routerStore.get();
    expect(s.screen).toBe('summary');
    if (s.screen === 'summary') expect(s.summary).toBe(dummySummary);
    expect(feedbackStore.get().message).toBeNull();
  });

  it('reports error and stays put on invalid transition workflow → setup', () => {
    routerStore.navigate({ to: 'workflow', feature: 'x' });
    routerStore.navigate({ to: 'setup' });
    expect(routerStore.get().screen).toBe('workflow');
    expect(feedbackStore.get().isError).toBe(true);
    expect(feedbackStore.get().message).toMatch(/Cannot navigate from "workflow" to "setup"/);
  });

  it('sessionId and status round-trip through navigate({ to: "summary" })', () => {
    routerStore.navigate({ to: 'workflow', feature: 'x' });
    routerStore.navigate({
      to: 'summary',
      summary: dummySummary,
      sessionId: 'abc',
      status: 'failed',
    });
    const s = routerStore.get();
    expect(s.screen).toBe('summary');
    if (s.screen === 'summary') {
      expect(s.sessionId).toBe('abc');
      expect(s.status).toBe('failed');
    }
  });

  it('replaces one summary route with another summary route', () => {
    const nextSummary = { ...dummySummary, feature: 'replacement' };
    routerStore.navigate({
      to: 'summary',
      summary: dummySummary,
      sessionId: 'first',
      status: 'complete',
    });
    routerStore.navigate({
      to: 'summary',
      summary: nextSummary,
      sessionId: 'second',
      status: 'interrupted',
    });

    const s = routerStore.get();
    expect(s.screen).toBe('summary');
    if (s.screen === 'summary') {
      expect(s.summary).toBe(nextSummary);
      expect(s.sessionId).toBe('second');
      expect(s.status).toBe('interrupted');
    }
    expect(feedbackStore.get().message).toBeNull();
  });

  it('init sets arbitrary route', () => {
    routerStore.init({ screen: 'workflow', feature: 'resume' });
    expect(routerStore.get().screen).toBe('workflow');
  });
});
