import { describe, it, expect, beforeEach } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeRunRecord } from '#testing/helpers/factories/run-record.js';
import { routerStore } from './router.js';
import { feedbackStore } from '../ui/feedback.js';
import {
  parsePreparedConfig,
  type PreparedExecution,
} from '../../engine/runners/prepared-execution.js';
import type { NavigateArgs } from './router.js';

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
    run: makeRunRecord(),
    execution: { kind: 'local', prepared: preparedExecution(feature) },
  };
}

function atRestWorkflow(sessionId: string): NavigateArgs {
  return {
    to: 'workflow',
    run: makeRunRecord({ ref: { projectDir: '/router-test', sessionId } }),
    execution: { kind: 'at-rest' },
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

  it('opens a past run at rest from home', () => {
    routerStore.navigate(atRestWorkflow('2026-09-14-past-run'));
    const s = routerStore.get();
    expect(s.screen).toBe('workflow');
    if (s.screen === 'workflow') {
      expect(s.execution.kind).toBe('at-rest');
      expect(s.run.ref.sessionId).toBe('2026-09-14-past-run');
    }
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

  it('navigates workflow → home', () => {
    routerStore.navigate(localWorkflow('x'));
    routerStore.navigate({ to: 'home' });
    expect(routerStore.get().screen).toBe('home');
  });

  it('navigates setup → workflow and clears prior navigation feedback', () => {
    feedbackStore.setMessage('saved');
    routerStore.navigate({ to: 'setup' });
    routerStore.navigate(localWorkflow('from setup'));
    expect(routerStore.get().screen).toBe('workflow');
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

  it('settles a local run in place: the same route, a new record, nothing running', () => {
    routerStore.navigate(localWorkflow('x'));
    const settled = makeRunRecord({ status: { kind: 'closed', as: 'complete' } });

    routerStore.updateRun({ run: settled, execution: { kind: 'at-rest' } });

    const route = routerStore.get();
    expect(route.screen).toBe('workflow');
    if (route.screen === 'workflow') {
      expect(route.run).toBe(settled);
      expect(route.execution.kind).toBe('at-rest');
    }
  });

  it('keeps the execution when only the record changed', () => {
    routerStore.navigate(localWorkflow('x'));
    const accepted = makeRunRecord({ checkpoint: { kind: 'accepted' } });

    routerStore.updateRun({ run: accepted });

    const route = routerStore.get();
    if (route.screen === 'workflow') {
      expect(route.run.checkpoint).toEqual({ kind: 'accepted' });
      expect(route.execution.kind).toBe('local');
    }
  });

  it('ignores a record update while another screen is showing', () => {
    routerStore.updateRun({ run: makeRunRecord() });
    expect(routerStore.get().screen).toBe('home');
  });

  it('represents only prepared local workflow routes', () => {
    const prepared = preparedExecution('resume');
    routerStore.init({
      screen: 'workflow',
      run: makeRunRecord(),
      execution: { kind: 'local', prepared },
    });

    const local = routerStore.get();
    expect(local.screen).toBe('workflow');
    if (local.screen === 'workflow' && local.execution.kind === 'local') {
      expect(local.execution.prepared).toBe(prepared);
    }

    const partial: NavigateArgs = {
      to: 'workflow',
      run: makeRunRecord(),
      // @ts-expect-error partial local workflow routes are forbidden
      execution: { kind: 'local' },
    };
    expect(partial).toBeDefined();
  });
});
