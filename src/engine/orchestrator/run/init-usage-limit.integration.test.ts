import { realpathSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withTempDir } from '#testing/helpers/temp-dir.js';
import { useTrustHome } from '#testing/helpers/trust-home.js';
import {
  makeCallbacks,
  makeImplementer,
  makePlanner,
} from '#testing/helpers/orchestrator-factories.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeRunnerGate } from '#testing/helpers/runner-gate.js';
import { loadState } from '../../../core/state/persistence.js';
import type { Config } from '../../../core/schemas/config.js';
import type { SpecMetadata } from '../../../core/paths-io.js';
import { ensureSessionDir } from '../../../core/paths-io.js';
import { reactivateExistingSession } from '../../../core/sessions/active-pointer.js';
import { resolveImplementerProfiles } from '../../../core/config/accessors/implementer-profiles.js';
import { configuredReviewerRunner } from '../../../core/config/accessors/reviewer-runner.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { EngineEvent, EventBus } from '../../events/types.js';
import { createEventBus } from '../../events/bus.js';
import { readRunEvents } from '../../events/replay.js';
import type { RunnerCallEvent } from '../../calls/types.js';
import { normalizeRunnerCallWarning } from '../../calls/warnings.js';
import type { SummaryBase } from '../summary/build.js';
import { publishRunnerCallEvent } from '../events.js';
import { initializeWorkflow } from './init.js';
import { createRunIsolation } from '../isolation/create.js';
import type { RunIsolation } from '../isolation/types.js';
import { parsePreparedConfig, type PreparedExecution } from '../../runners/prepared-execution.js';
import { markHooksConfigTrusted } from '../../../core/hooks/trust.js';

const WEEKLY_RESET_MS = Date.parse('2026-10-29T10:00:00.000Z');

function makeCopyingIsolation(projectDir: string, sessionId: string): RunIsolation {
  return createRunIsolation({
    projectDir,
    sessionId,
    strategy: 'staged-copy',
    onFallback: () => {},
  });
}

async function preparedTestExecution(
  input: Readonly<{ projectDir: string; sessionId: string; feature: string; inputConfig: Config }>,
): Promise<Readonly<{ config: Config; execution: PreparedExecution }>> {
  const hooks = input.inputConfig.hooks;
  if (hooks !== undefined) markHooksConfigTrusted(input.projectDir, hooks);
  const config = parsePreparedConfig(
    hooks === undefined ? input.inputConfig : { ...input.inputConfig, hooks },
  );
  const preparationId = `initialize-usage-${input.sessionId}`;
  const configuredReviewer = configuredReviewerRunner(config);
  const gates = [
    makeRunnerGate(config.planner, { role: 'planner' }, preparationId),
    ...resolveImplementerProfiles(config).profiles.map((profile) =>
      makeRunnerGate(profile.config, { role: 'implementer', profile: profile.name }, preparationId),
    ),
    ...(configuredReviewer === undefined
      ? []
      : [makeRunnerGate(configuredReviewer, { role: 'reviewer' }, preparationId)]),
  ];
  ensureSessionDir(input.projectDir, input.sessionId);
  const active = reactivateExistingSession({
    projectDir: input.projectDir,
    sessionId: input.sessionId,
  });
  return {
    config,
    execution: {
      purpose: 'new-workflow',
      config,
      sourceConfig: config,
      preparationId,
      report: {
        generatedAt: new Date(0).toISOString(),
        projectDir: input.projectDir,
        status: 'ready',
        counts: { ok: gates.length, info: 0, warning: 0, blocker: 0 },
        nextAction: { kind: 'continue', label: 'Continue', reason: 'ready' },
        sections: [],
        metadata: {},
      },
      gates,
      session: {
        kind: 'existing',
        ref: { projectDir: input.projectDir, sessionId: input.sessionId },
        active,
      },
      runtime: {
        feature: input.feature,
        allowHooks: true,
        allowRepoRunners: false,
      },
    },
  };
}

async function initializeUsageWorkflow(
  input: Readonly<{
    projectDir: string;
    sessionId: string;
    feature: string;
    savedState?: WorkflowState | undefined;
    eventBus?: EventBus;
    eventSink?: (event: EngineEvent) => void;
  }>,
) {
  const config = makeConfig({
    validation: { endChecks: false, testCommand: 'noop' },
    workflow: {},
    approval: { feedRejectionsToPlanner: true },
    codebase: { enabled: false, tokenBudget: 4000 },
  });
  const prepared = await preparedTestExecution({
    projectDir: input.projectDir,
    sessionId: input.sessionId,
    feature: input.feature,
    inputConfig: config,
  });
  const plannerTool = 'test-planner';
  const summaryBase: SummaryBase = {
    feature: input.feature,
    startTime: Date.now(),
    plannerTool,
    implementerTool: 'test-implementer',
    projectDir: input.projectDir,
    sessionId: input.sessionId,
  };
  const metadata: SpecMetadata = {
    planner: `${plannerTool} · auto`,
    implementer: 'test-implementer · auto',
    reviewer: `${plannerTool} · auto`,
  };
  return initializeWorkflow({
    opts: {
      prepared: prepared.execution,
      callbacks: makeCallbacks().callbacks,
      sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
      savedState: input.savedState,
      eventBus: input.eventBus,
      _planner: makePlanner(),
      _implementer: makeImplementer(),
      _eventSink: input.eventSink,
    },
    config: prepared.config,
    sessionId: input.sessionId,
    summaryBase,
    metadata,
    setTrackedState: () => {},
    resumeHolder: { messages: [] },
    isolation: makeCopyingIsolation(input.projectDir, input.sessionId),
    savedState: input.savedState,
  });
}

function weeklyWarning(step: number): RunnerCallEvent {
  return {
    type: 'call_warning',
    ts: 1_000 + step,
    callId: `call-weekly-${step}`,
    role: 'planner',
    backendKind: 'cli',
    warning: normalizeRunnerCallWarning({
      code: 'claude_rate_limit',
      message: `You've used ${step}% of your Claude Code weekly limit · resets Oct 29, 10:00`,
      usage: { window: 'seven_day', step, resetsAt: WEEKLY_RESET_MS },
    }),
  };
}

let trustHome: ReturnType<typeof useTrustHome>;

beforeEach(() => {
  trustHome = useTrustHome('initialize-usage-limit-trust-home');
});

afterEach(() => {
  trustHome.restore();
});

describe('initializeWorkflow — a usage step shown before a stop', () => {
  it('does not repeat a shown usage step on a continued run and still shows the next one', async () => {
    await withTempDir('splitbrief-init-usage-limit', async (tempDir) => {
      const projectDir = realpathSync(tempDir);
      const feature = 'continue past a usage warning';
      const sessionId = 'session-init-usage-limit';
      const firstBus = createEventBus();
      const started = await initializeUsageWorkflow({
        projectDir,
        sessionId,
        feature,
        eventBus: firstBus,
      });
      expect(started.ok).toBe(true);
      publishRunnerCallEvent(
        { bus: firstBus, phase: 'planning', rootDir: projectDir },
        weeklyWarning(75),
      );
      const recorded = (await readRunEvents({ projectDir, sessionId })).events.filter(
        (event) => event.type === 'runner_call_warning',
      );
      expect(recorded).toHaveLength(1);
      expect(recorded[0]).toMatchObject({ warning: { usage: { window: 'seven_day', step: 75 } } });

      const savedState = loadState({ projectDir, sessionId });
      if (savedState === null) throw new Error('The first run saved no state');

      const continuedBus = createEventBus();
      const shown: EngineEvent[] = [];
      continuedBus.subscribe((event) => shown.push(event));
      const continued = await initializeUsageWorkflow({
        projectDir,
        sessionId,
        feature,
        savedState,
        eventBus: continuedBus,
      });
      expect(continued.ok).toBe(true);

      publishRunnerCallEvent(
        { bus: continuedBus, phase: 'planning', rootDir: projectDir },
        weeklyWarning(75),
      );
      publishRunnerCallEvent(
        { bus: continuedBus, phase: 'planning', rootDir: projectDir },
        weeklyWarning(80),
      );

      const warnings = shown.filter((event) => event.type === 'runner_call_warning');
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatchObject({ warning: { usage: { step: 80 } } });
    });
  });
});
