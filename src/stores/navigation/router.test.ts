import { describe, it, expect, beforeEach } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { routerStore } from './router.js';
import { feedbackStore } from '../ui/feedback.js';
import type { Summary } from '../../core/schemas/summary.js';
import {
  parsePreparedConfig,
  type PreparedExecution,
} from '../../engine/runners/prepared-execution.js';
import type { NavigateArgs } from './router.js';

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

function preparedExecution(feature: string): PreparedExecution {
  const sessionId = 'router-test-session';
  const active = {
    version: 1 as const,
    sessionId,
    generation: '11111111-1111-4111-8111-111111111111',
  };
  return {
    purpose: 'resume',
    config: parsePreparedConfig(makeConfig()),
    preparationId: 'router-test-preparation',
    report: {
      generatedAt: '2026-08-04T00:00:00.000Z',
      projectDir: '/router-test',
      status: 'ready',
      counts: { ok: 1, info: 0, warning: 0, blocker: 0 },
      nextAction: { kind: 'continue', label: 'Continue', reason: 'Ready' },
      sections: [],
      metadata: {},
    },
    gates: [],
    session: {
      kind: 'existing',
      ref: { projectDir: '/router-test', sessionId },
      active,
    },
    runtime: {
      feature,
      allowRepoRunners: false,
      allowHooks: false,
    },
  };
}

function localWorkflow(feature: string): NavigateArgs {
  return {
    to: 'workflow',
    execution: { kind: 'local', prepared: preparedExecution(feature) },
  };
}

describe('routerStore', () => {
  beforeEach(() => {
    routerStore.reset();
    feedbackStore.reset();
  });

  it('navigates home → workflow', () => {
    routerStore.navigate(localWorkflow('auth'));
    const s = routerStore.get();
    expect(s.screen).toBe('workflow');
    if (s.screen === 'workflow' && s.execution.kind === 'local') {
      expect(s.execution.prepared.runtime.feature).toBe('auth');
    }
  });

  it('navigates workflow → summary', () => {
    routerStore.navigate(localWorkflow('x'));
    routerStore.navigate({ to: 'summary', summary: dummySummary, status: 'complete' });
    const s = routerStore.get();
    expect(s.screen).toBe('summary');
    if (s.screen === 'summary') expect(s.summary).toBe(dummySummary);
  });

  it('replaces a workflow route with an exactly prepared resumed workflow', () => {
    routerStore.navigate(localWorkflow('first'));
    routerStore.navigate(localWorkflow('resumed'));

    const route = routerStore.get();
    expect(route.screen).toBe('workflow');
    if (route.screen === 'workflow' && route.execution.kind === 'local') {
      expect(route.execution.prepared.runtime.feature).toBe('resumed');
    }
  });

  it('navigates summary → home', () => {
    routerStore.navigate(localWorkflow('x'));
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

  it('navigates setup → summary and clears prior navigation feedback', () => {
    feedbackStore.setMessage('saved');
    routerStore.navigate({ to: 'setup' });
    routerStore.navigate({ to: 'summary', summary: dummySummary, status: 'complete' });
    const s = routerStore.get();
    expect(s.screen).toBe('summary');
    if (s.screen === 'summary') expect(s.summary).toBe(dummySummary);
    expect(feedbackStore.get().message).toBeNull();
    expect(feedbackStore.get().isError).toBe(false);
  });

  it('reports error and stays put on invalid transition workflow → setup', () => {
    routerStore.navigate(localWorkflow('x'));
    feedbackStore.setTransientError('prior error');
    routerStore.navigate({ to: 'setup' });
    expect(routerStore.get().screen).toBe('workflow');
    expect(feedbackStore.get().isError).toBe(true);
    expect(feedbackStore.get().message).toMatch(/Cannot navigate from "workflow" to "setup"/);
  });

  it('sessionId and status round-trip through navigate({ to: "summary" })', () => {
    routerStore.navigate(localWorkflow('x'));
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

  it('represents only prepared local or attached workflow routes', () => {
    const prepared = preparedExecution('resume');
    routerStore.init({ screen: 'workflow', execution: { kind: 'local', prepared } });

    const local = routerStore.get();
    expect(local.screen).toBe('workflow');
    if (local.screen === 'workflow' && local.execution.kind === 'local') {
      expect(local.execution.prepared).toBe(prepared);
    }

    routerStore.init({
      screen: 'workflow',
      execution: {
        kind: 'attached',
        feature: 'remote workflow',
        sessionId: 'attached-session',
        attach: { sockPath: '/tmp/splitbrief.sock', authToken: 'token' },
      },
    });

    const attached = routerStore.get();
    expect(attached.screen).toBe('workflow');
    if (attached.screen === 'workflow' && attached.execution.kind === 'attached') {
      expect(attached.execution.feature).toBe('remote workflow');
      expect(attached.execution.attach.sockPath).toBe('/tmp/splitbrief.sock');
    }

    // @ts-expect-error partial local workflow routes are forbidden
    const partial: NavigateArgs = { to: 'workflow', execution: { kind: 'local' } };
    expect(partial).toBeDefined();
  });
});
