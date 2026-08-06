import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withTempDir } from '#testing/helpers/temp-dir.js';
import { useTrustHome } from '#testing/helpers/trust-home.js';
import {
  makeCallbacks,
  makeImplementer,
  makePlanner,
} from '#testing/helpers/orchestrator-factories.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeRunnerGate } from '#testing/helpers/runner-gate.js';
import { createInitialState } from '../../../core/state/machine.js';
import type { Config } from '../../../core/schemas/config.js';
import type { SpecMetadata } from '../../../core/paths-io.js';
import { ensureSessionDir } from '../../../core/paths-io.js';
import { reactivateExistingSession } from '../../../core/sessions/lifecycle.js';
import { resolveImplementerProfiles } from '../../../core/config/accessors/implementer-profiles.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { EngineEvent } from '../../events/types.js';
import { runPreHooks } from '../../hooks/run-pre.js';
import { formatValidationError } from '../validation/format-error.js';
import { loadState } from '../../../core/state/persistence.js';
import type { SummaryBase } from '../summary/build.js';
import { initializeWorkflow } from './init.js';
import { createRunIsolation } from '../isolation/create.js';
import type { RunIsolation } from '../isolation/types.js';
import { parsePreparedConfig, type PreparedExecution } from '../../runners/prepared-execution.js';
import { resolveHooksConfig } from '../../hooks/discover.js';
import { markHooksConfigTrusted } from '../../../core/hooks/trust.js';

function makeCopyingIsolation(projectDir: string, sessionId: string): RunIsolation {
  return createRunIsolation({
    projectDir,
    sessionId,
    strategy: 'staged-copy',
    onFallback: () => {},
    onRetained: () => {},
  });
}

async function preparedTestExecution(
  input: Readonly<{
    projectDir: string;
    sessionId: string;
    feature: string;
    inputConfig: Config;
    allowHooks: boolean;
    allowRepoRunners?: boolean;
  }>,
): Promise<Readonly<{ config: Config; execution: PreparedExecution }>> {
  const hooks = await resolveHooksConfig(input.projectDir, input.inputConfig.hooks);
  if (hooks !== undefined && input.allowHooks) markHooksConfigTrusted(input.projectDir, hooks);
  const config = parsePreparedConfig(
    hooks === undefined ? input.inputConfig : { ...input.inputConfig, hooks },
  );
  const preparationId = `initialize-workflow-${input.sessionId}`;
  const gates = [
    makeRunnerGate(config.planner, { role: 'planner' }, preparationId),
    ...resolveImplementerProfiles(config).profiles.map((profile) =>
      makeRunnerGate(profile.config, { role: 'implementer', profile: profile.name }, preparationId),
    ),
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
        allowHooks: input.allowHooks,
        allowRepoRunners: input.allowRepoRunners ?? false,
      },
    },
  };
}

let trustHome: ReturnType<typeof useTrustHome>;

beforeEach(() => {
  trustHome = useTrustHome('initialize-workflow-trust-home');
});

afterEach(() => {
  trustHome.restore();
});

describe('initializeWorkflow', () => {
  it('registers discovered pre-task modules when config has no hooks', async () => {
    await withTempDir('splitbrief-init-hooks', async (projectDir) => {
      const hooksDir = join(projectDir, '.splitbrief', 'hooks');
      await mkdir(hooksDir, { recursive: true });
      await writeFile(
        join(hooksDir, 'pre-task.ts'),
        'export default () => ({ kind: "deny", message: "blocked by discovered hook" });\n',
      );

      const feature = 'use discovered hook';
      const sessionId = 'session-init-hooks';
      const config = makeConfig({
        validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
        workflow: { mode: 'quick', persistTranscript: false },
        approval: { enabled: false, feedRejectionsToPlanner: true },
        codebase: { enabled: false, tokenBudget: 4000, cacheDir: '.splitbrief' },
      });
      const { callbacks } = makeCallbacks();
      const summaryBase: SummaryBase = {
        feature,
        startTime: Date.now(),
        plannerTool: 'test-planner',
        implementerTool: 'test-implementer',
        mode: 'quick',
        projectDir,
        sessionId,
      };
      const metadata: SpecMetadata = {
        plannerTool: 'test-planner',
        implementerTool: 'test-implementer',
        mode: 'quick',
      };
      let trackedState: WorkflowState | undefined;
      const prepared = await preparedTestExecution({
        projectDir,
        sessionId,
        feature,
        inputConfig: config,
        allowHooks: true,
      });

      const init = await initializeWorkflow({
        opts: {
          prepared: prepared.execution,
          callbacks,
          sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
          _planner: makePlanner(),
          _implementer: makeImplementer(),
        },
        config: prepared.config,
        sessionId,
        summaryBase,
        metadata,
        setTrackedState: (state) => {
          trackedState = state;
        },
        resumeHolder: { messages: [] },
        isolation: makeCopyingIsolation(projectDir, sessionId),
      });

      expect(init.ok).toBe(true);
      expect(trackedState?.feature).toBe(feature);
      if (!init.ok) return;

      const task = makeTask();
      const preTaskPayload: EngineEvent = {
        type: 'task_started',
        ts: 1,
        phase: 'implementing',
        taskId: task.id,
        title: task.title,
        index: 0,
        total: 1,
        file: task.file,
        action: task.action,
      };
      const result = await runPreHooks(init.wctx.config.hooks, 'pre_task', preTaskPayload, {
        projectDir,
        sessionId,
      });

      expect(result).toEqual({
        allow: false,
        reason: 'blocked by discovered hook',
        warnings: [],
      });
    });
  });

  it('persists the selected skill ids in the initial workflow state on a fresh run', async () => {
    await withTempDir('splitbrief-init-skills', async (projectDir) => {
      const feature = 'feature needing skills';
      const sessionId = 'session-init-skills';
      const config = makeConfig({
        validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
        workflow: { mode: 'quick', persistTranscript: false },
        approval: { enabled: false, feedRejectionsToPlanner: true },
        codebase: { enabled: false, tokenBudget: 4000, cacheDir: '.splitbrief' },
      });
      const { callbacks } = makeCallbacks();
      const summaryBase: SummaryBase = {
        feature,
        startTime: Date.now(),
        plannerTool: 'test-planner',
        implementerTool: 'test-implementer',
        mode: 'quick',
        projectDir,
        sessionId,
      };
      const metadata: SpecMetadata = {
        plannerTool: 'test-planner',
        implementerTool: 'test-implementer',
        mode: 'quick',
      };
      let trackedState: WorkflowState | undefined;
      const prepared = await preparedTestExecution({
        projectDir,
        sessionId,
        feature,
        inputConfig: config,
        allowHooks: true,
      });

      const init = await initializeWorkflow({
        opts: {
          prepared: prepared.execution,
          callbacks,
          sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
          _planner: makePlanner(),
          _implementer: makeImplementer(),
          selectedSkills: [
            {
              id: 'typescript',
              name: 'TypeScript',
              description: 'ts skill',
              path: '/skills/typescript/SKILL.md',
              scope: 'global',
            },
            {
              id: 'react',
              name: 'React',
              description: 'react skill',
              path: '/skills/react/SKILL.md',
              scope: 'global',
            },
          ],
        },
        config: prepared.config,
        sessionId,
        summaryBase,
        metadata,
        setTrackedState: (state) => {
          trackedState = state;
        },
        resumeHolder: { messages: [] },
        isolation: makeCopyingIsolation(projectDir, sessionId),
      });

      expect(init.ok).toBe(true);
      expect(trackedState?.selectedSkills).toEqual(['typescript', 'react']);
      expect(loadState({ projectDir, sessionId })?.selectedSkills).toEqual(['typescript', 'react']);
    });
  });

  it('surfaces the api provider cause when an api planner is unavailable', async () => {
    await withTempDir('splitbrief-init-api-unavailable', async (projectDir) => {
      const feature = 'needs a reachable provider';
      const sessionId = 'session-init-api-unavailable';
      const config = makeConfig({
        planner: {
          kind: 'api',
          provider: 'openrouter',
          model: 'some-model',
          apiBase: 'https://openrouter.ai/api/v1',
          apiKey: 'k',
        },
        validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
        workflow: { mode: 'quick', persistTranscript: false },
        approval: { enabled: false, feedRejectionsToPlanner: true },
        codebase: { enabled: false, tokenBudget: 4000, cacheDir: '.splitbrief' },
      });
      const { callbacks } = makeCallbacks();
      const events: EngineEvent[] = [];
      const summaryBase: SummaryBase = {
        feature,
        startTime: Date.now(),
        plannerTool: 'openrouter',
        implementerTool: 'test-implementer',
        mode: 'quick',
        projectDir,
        sessionId,
      };
      const metadata: SpecMetadata = {
        plannerTool: 'openrouter',
        implementerTool: 'test-implementer',
        mode: 'quick',
      };
      const prepared = await preparedTestExecution({
        projectDir,
        sessionId,
        feature,
        inputConfig: config,
        allowHooks: true,
      });

      const init = await initializeWorkflow({
        opts: {
          prepared: prepared.execution,
          callbacks,
          sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
          _planner: makePlanner({
            isAvailable: vi.fn().mockResolvedValue(false),
            unavailabilityReason: () => 'HTTP 401',
          }),
          _implementer: makeImplementer(),
          _eventSink: (e) => events.push(e),
        },
        config: prepared.config,
        sessionId,
        summaryBase,
        metadata,
        setTrackedState: () => {},
        resumeHolder: { messages: [] },
        isolation: makeCopyingIsolation(projectDir, sessionId),
      });

      expect(init.ok).toBe(false);
      const errorEvent = events.find(
        (e): e is Extract<EngineEvent, { type: 'error' }> => e.type === 'error',
      );
      expect(errorEvent?.message).toContain("Planner 'openrouter' is not available");
      expect(errorEvent?.message).toContain('HTTP 401');
      expect(errorEvent?.message).not.toContain("Make sure it's installed");
    });
  });

  it('does not publish a planner_status fallback when resuming an implementer phase', async () => {
    await withTempDir('splitbrief-init-resume-implementing', async (projectDir) => {
      const feature = 'resume implementation';
      const sessionId = 'session-init-resume-implementing';
      const config = makeConfig({
        validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
        workflow: { mode: 'quick', persistTranscript: false },
        approval: { enabled: false, feedRejectionsToPlanner: true },
        codebase: { enabled: false, tokenBudget: 4000, cacheDir: '.splitbrief' },
      });
      const { callbacks } = makeCallbacks();
      const events: EngineEvent[] = [];
      const summaryBase: SummaryBase = {
        feature,
        startTime: Date.now(),
        plannerTool: 'test-planner',
        implementerTool: 'test-implementer',
        mode: 'quick',
        projectDir,
        sessionId,
      };
      const metadata: SpecMetadata = {
        plannerTool: 'test-planner',
        implementerTool: 'test-implementer',
        mode: 'quick',
      };
      const prepared = await preparedTestExecution({
        projectDir,
        sessionId,
        feature,
        inputConfig: config,
        allowHooks: true,
      });

      const init = await initializeWorkflow({
        opts: {
          prepared: prepared.execution,
          callbacks,
          sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
          savedState: { ...createInitialState(feature), phase: 'implementing' },
          _planner: makePlanner(),
          _implementer: makeImplementer(),
          _eventSink: (e) => events.push(e),
        },
        config: prepared.config,
        sessionId,
        summaryBase,
        metadata,
        setTrackedState: () => {},
        resumeHolder: { messages: [] },
        isolation: makeCopyingIsolation(projectDir, sessionId),
      });

      expect(init.ok).toBe(true);
      expect(events).toContainEqual(expect.objectContaining({ type: 'workflow_resumed' }));
      expect(events).not.toContainEqual(
        expect.objectContaining({
          type: 'planner_status',
          phase: 'implementing',
          status: 'running',
        }),
      );
    });
  });

  it('cli planner without a reason keeps the install hint', async () => {
    await withTempDir('splitbrief-init-cli-unavailable', async (projectDir) => {
      const feature = 'needs an installed cli';
      const sessionId = 'session-init-cli-unavailable';
      const config = makeConfig({
        planner: { kind: 'cli', tool: 'claude-code' },
        validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
        workflow: { mode: 'quick', persistTranscript: false },
        approval: { enabled: false, feedRejectionsToPlanner: true },
        codebase: { enabled: false, tokenBudget: 4000, cacheDir: '.splitbrief' },
      });
      const { callbacks } = makeCallbacks();
      const events: EngineEvent[] = [];
      const summaryBase: SummaryBase = {
        feature,
        startTime: Date.now(),
        plannerTool: 'claude-code',
        implementerTool: 'test-implementer',
        mode: 'quick',
        projectDir,
        sessionId,
      };
      const metadata: SpecMetadata = {
        plannerTool: 'claude-code',
        implementerTool: 'test-implementer',
        mode: 'quick',
      };
      const prepared = await preparedTestExecution({
        projectDir,
        sessionId,
        feature,
        inputConfig: config,
        allowHooks: true,
      });

      const init = await initializeWorkflow({
        opts: {
          prepared: prepared.execution,
          callbacks,
          sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
          _planner: makePlanner({ isAvailable: vi.fn().mockResolvedValue(false) }),
          _implementer: makeImplementer(),
          _eventSink: (e) => events.push(e),
        },
        config: prepared.config,
        sessionId,
        summaryBase,
        metadata,
        setTrackedState: () => {},
        resumeHolder: { messages: [] },
        isolation: makeCopyingIsolation(projectDir, sessionId),
      });

      expect(init.ok).toBe(false);
      const errorEvent = events.find(
        (e): e is Extract<EngineEvent, { type: 'error' }> => e.type === 'error',
      );
      expect(errorEvent?.message).toBe(
        "Planner 'claude-code' is not available. Make sure it's installed.",
      );
    });
  });

  it('cli planner unavailability message includes the probe reason when present', async () => {
    await withTempDir('splitbrief-init-cli-unavailable-reason', async (projectDir) => {
      const feature = 'needs an installed cli';
      const sessionId = 'session-init-cli-unavailable-reason';
      const config = makeConfig({
        planner: { kind: 'cli', tool: 'claude-code' },
        validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
        workflow: { mode: 'quick', persistTranscript: false },
        approval: { enabled: false, feedRejectionsToPlanner: true },
        codebase: { enabled: false, tokenBudget: 4000, cacheDir: '.splitbrief' },
      });
      const { callbacks } = makeCallbacks();
      const events: EngineEvent[] = [];
      const summaryBase: SummaryBase = {
        feature,
        startTime: Date.now(),
        plannerTool: 'claude-code',
        implementerTool: 'test-implementer',
        mode: 'quick',
        projectDir,
        sessionId,
      };
      const metadata: SpecMetadata = {
        plannerTool: 'claude-code',
        implementerTool: 'test-implementer',
        mode: 'quick',
      };
      const prepared = await preparedTestExecution({
        projectDir,
        sessionId,
        feature,
        inputConfig: config,
        allowHooks: true,
      });

      const init = await initializeWorkflow({
        opts: {
          prepared: prepared.execution,
          callbacks,
          sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
          _planner: makePlanner({
            isAvailable: vi.fn().mockResolvedValue(false),
            unavailabilityReason: () => 'probe timed out after 5s',
          }),
          _implementer: makeImplementer(),
          _eventSink: (e) => events.push(e),
        },
        config: prepared.config,
        sessionId,
        summaryBase,
        metadata,
        setTrackedState: () => {},
        resumeHolder: { messages: [] },
        isolation: makeCopyingIsolation(projectDir, sessionId),
      });

      expect(init.ok).toBe(false);
      const errorEvent = events.find(
        (e): e is Extract<EngineEvent, { type: 'error' }> => e.type === 'error',
      );
      expect(errorEvent?.message).toBe(
        "Planner 'claude-code' is not available: probe timed out after 5s.",
      );
    });
  });

  it('builds a validator that captures the run-start baseline and consults it at acceptance', async () => {
    await withTempDir('splitbrief-init-baseline', async (projectDir) => {
      const feature = 'red-at-start project';
      const sessionId = 'session-init-baseline';
      const config = makeConfig({
        validation: {
          typecheck: true,
          lint: false,
          test: false,
          typecheckCommand: 'node -e "process.exit(1)"',
        },
        workflow: { mode: 'quick', persistTranscript: false },
        approval: { enabled: false, feedRejectionsToPlanner: true },
        codebase: { enabled: false, tokenBudget: 4000, cacheDir: '.splitbrief' },
      });
      const { callbacks } = makeCallbacks();
      const summaryBase: SummaryBase = {
        feature,
        startTime: Date.now(),
        plannerTool: 'test-planner',
        implementerTool: 'test-implementer',
        mode: 'quick',
        projectDir,
        sessionId,
      };
      const metadata: SpecMetadata = {
        plannerTool: 'test-planner',
        implementerTool: 'test-implementer',
        mode: 'quick',
      };
      const prepared = await preparedTestExecution({
        projectDir,
        sessionId,
        feature,
        inputConfig: config,
        allowHooks: true,
      });

      const init = await initializeWorkflow({
        opts: {
          prepared: prepared.execution,
          callbacks,
          sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
          _planner: makePlanner(),
          _implementer: makeImplementer(),
        },
        config: prepared.config,
        sessionId,
        summaryBase,
        metadata,
        setTrackedState: () => {},
        resumeHolder: { messages: [] },
        isolation: makeCopyingIsolation(projectDir, sessionId),
      });

      expect(init.ok).toBe(true);
      if (!init.ok) return;

      await init.wctx.validator.primeBaseline({
        bus: init.wctx.bus,
        phase: 'implementing',
        task: makeTask({ file: 'src/app.ts', action: 'modify' }),
        projectDir,
        config,
      });
      const results = await init.wctx.validator.runValidation({
        task: makeTask({ file: 'src/app.ts', action: 'modify' }),
        projectDir,
        config,
        bus: init.wctx.bus,
        phase: 'implementing',
      });

      const acceptance = init.wctx.validator.decideAcceptance({
        results,
        changedFiles: ['src/app.ts'],
      });
      expect(acceptance.accepted).toBe(false);
      expect(acceptance.blockingStages).toContain('typecheck');

      const error = formatValidationError(results, acceptance);
      expect(error).not.toBe('');
    });
  });

  it('carries the run-scoped isolation handle on the workflow context', async () => {
    await withTempDir('splitbrief-init-isolation', async (projectDir) => {
      const feature = 'carry isolation handle';
      const sessionId = 'session-init-isolation';
      const config = makeConfig({
        validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
        workflow: { mode: 'quick', persistTranscript: false },
        approval: { enabled: false, feedRejectionsToPlanner: true },
        codebase: { enabled: false, tokenBudget: 4000, cacheDir: '.splitbrief' },
      });
      const { callbacks } = makeCallbacks();
      const summaryBase: SummaryBase = {
        feature,
        startTime: Date.now(),
        plannerTool: 'test-planner',
        implementerTool: 'test-implementer',
        mode: 'quick',
        projectDir,
        sessionId,
      };
      const metadata: SpecMetadata = {
        plannerTool: 'test-planner',
        implementerTool: 'test-implementer',
        mode: 'quick',
      };
      const prepared = await preparedTestExecution({
        projectDir,
        sessionId,
        feature,
        inputConfig: config,
        allowHooks: true,
      });
      const isolation = makeCopyingIsolation(projectDir, sessionId);

      const init = await initializeWorkflow({
        opts: {
          prepared: prepared.execution,
          callbacks,
          sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
          _planner: makePlanner(),
          _implementer: makeImplementer(),
        },
        config: prepared.config,
        sessionId,
        summaryBase,
        metadata,
        setTrackedState: () => {},
        resumeHolder: { messages: [] },
        isolation,
      });

      expect(init.ok).toBe(true);
      if (!init.ok) return;
      expect(init.wctx.isolation).toBe(isolation);
    });
  });
});
