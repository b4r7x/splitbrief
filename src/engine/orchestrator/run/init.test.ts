import { realpathSync, renameSync, symlinkSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
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
import { stateAuthorityDirectory } from '../../../core/paths.js';
import { reactivateExistingSession } from '../../../core/sessions/active-pointer.js';
import { resolveImplementerProfiles } from '../../../core/config/accessors/implementer-profiles.js';
import { configuredReviewerRunner } from '../../../core/config/accessors/reviewer-runner.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { SkillMeta } from '../../../core/skills/types.js';
import type { StateAuthorityReceipt } from '../../../core/state/types.js';
import type { EngineEvent, EventBus } from '../../events/types.js';
import { createEventBus } from '../../events/bus.js';
import { runPreHooks } from '../../hooks/run-pre.js';
import { formatValidationError } from '../validation/format-error.js';
import { loadState, saveState } from '../../../core/state/persistence.js';
import { loadStateForResume } from '../../../core/state/resume-authority.js';
import { acquireStateAuthority } from '../../../core/state/authority.js';
import type { SummaryBase } from '../summary/build.js';
import {
  consumeNewWorkflowCandidate,
  refreshWorkflowAuthority,
  workflowAuthority,
} from './authority.js';
import { initializeWorkflow } from './init.js';
import { createRunIsolation } from '../isolation/create.js';
import type { RunIsolation } from '../isolation/types.js';
import { parsePreparedConfig, type PreparedExecution } from '../../runners/prepared-execution.js';
import { resolveHooksConfig } from '../../hooks/discover.js';
import { markHooksConfigTrusted } from '../../../core/hooks/trust.js';
import { installCompilerSeam } from '../../planners/base.js';
import { recordRuntimeConformance } from '../../runners/runtime-conformance-cache.js';
import { makeCompilerSeam } from '#testing/helpers/factories/compiler-seam.js';

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

async function initializeFencedWorkflow(
  input: Readonly<{
    projectDir: string;
    sessionId: string;
    feature: string;
    authority?: StateAuthorityReceipt;
    savedState?: WorkflowState | undefined;
    newWorkflow?: boolean;
    reviewer?: Config['reviewer'];
    configOverrides?: Parameters<typeof makeConfig>[0];
    plannerTool?: string;
    plannerRunner?: ReturnType<typeof makePlanner>;
    selectedSkills?: SkillMeta[];
    eventSink?: (event: EngineEvent) => void;
    eventBus?: EventBus;
    headless?: boolean;
    isolation?: RunIsolation;
  }>,
): Promise<{
  init: Awaited<ReturnType<typeof initializeWorkflow>>;
  config: Config;
  planner: ReturnType<typeof makePlanner>;
  implementer: ReturnType<typeof makeImplementer>;
  tracked: { current: WorkflowState | undefined };
}> {
  const config = makeConfig({
    validation: {
      typecheck: false,
      lint: false,
      test: false,
      testCommand: 'noop',
    },
    workflow: { mode: 'quick', persistTranscript: false },
    approval: { enabled: false, feedRejectionsToPlanner: true },
    codebase: { enabled: false, tokenBudget: 4000, cacheDir: '.splitbrief' },
    ...(input.reviewer === undefined ? {} : { reviewer: input.reviewer }),
    ...input.configOverrides,
  });
  const prepared = await preparedTestExecution({
    projectDir: input.projectDir,
    sessionId: input.sessionId,
    feature: input.feature,
    inputConfig: config,
    allowHooks: true,
  });
  const planner = input.plannerRunner ?? makePlanner();
  const implementer = makeImplementer();
  const plannerTool = input.plannerTool ?? 'test-planner';
  const summaryBase: SummaryBase = {
    feature: input.feature,
    startTime: Date.now(),
    plannerTool,
    implementerTool: 'test-implementer',
    mode: 'quick',
    projectDir: input.projectDir,
    sessionId: input.sessionId,
  };
  const metadata: SpecMetadata = {
    plannerTool,
    implementerTool: 'test-implementer',
    mode: 'quick',
  };
  const authorityHolder = input.authority === undefined ? undefined : { current: input.authority };
  const tracked: { current: WorkflowState | undefined } = { current: undefined };

  const init = await initializeWorkflow({
    opts: {
      prepared: prepared.execution,
      callbacks: makeCallbacks().callbacks,
      sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
      savedState: input.savedState,
      selectedSkills: input.selectedSkills,
      headless: input.headless,
      eventBus: input.eventBus,
      _planner: planner,
      _implementer: implementer,
      _eventSink: input.eventSink,
    },
    config: prepared.config,
    sessionId: input.sessionId,
    summaryBase,
    metadata,
    setTrackedState: (state) => {
      tracked.current = state;
      if (authorityHolder !== undefined) {
        authorityHolder.current = refreshWorkflowAuthority(
          { projectDir: input.projectDir, sessionId: input.sessionId },
          authorityHolder.current,
          state,
        );
      }
    },
    resumeHolder: { messages: [] },
    isolation: input.isolation ?? makeCopyingIsolation(input.projectDir, input.sessionId),
    authority: input.authority,
    authorityHolder,
    savedState: input.savedState,
    newWorkflow: input.newWorkflow,
  });

  return { init, config, planner, implementer, tracked };
}

let trustHome: ReturnType<typeof useTrustHome>;

beforeEach(() => {
  trustHome = useTrustHome('initialize-workflow-trust-home');
});

afterEach(() => {
  trustHome.restore();
});

describe('initializeWorkflow', () => {
  it.each([
    {
      name: 'seats the planner in the review chair when no reviewer is configured',
      reviewer: undefined,
      distinct: false,
    },
    {
      name: 'seats a distinct runner in the review chair when a reviewer is configured',
      reviewer: {
        kind: 'api',
        provider: 'custom-endpoint',
        service: 'custom-endpoint',
        offering: 'payg',
        apiBase: 'https://api.example.com/v1',
        apiKey: 'sk-custom-reviewer',
        model: 'reviewer-model',
      },
      distinct: true,
    },
  ] as const)('$name', async ({ reviewer, distinct }) => {
    await withTempDir('splitbrief-init-review-seat', async (tempDir) => {
      const projectDir = realpathSync(tempDir);
      const feature = 'review seat';
      const sessionId = 'session-init-review-seat';
      const ref = { projectDir, sessionId };
      ensureSessionDir(projectDir, sessionId);

      const acquired = acquireStateAuthority({
        ref,
        purpose: 'new-workflow',
        ownerId: 'seat-owner',
        runId: 'seat-run',
        acquisitionId: 'seat-acquisition',
      });
      if (acquired.kind !== 'new-workflow') throw new Error('expected a new workflow candidate');
      const authority = consumeNewWorkflowCandidate(ref, acquired.candidate, feature);

      const result = await initializeFencedWorkflow({
        projectDir,
        sessionId,
        feature,
        authority,
        savedState: loadState(ref) ?? undefined,
        newWorkflow: true,
        ...(reviewer === undefined ? {} : { reviewer }),
      });

      expect(result.init.ok).toBe(true);
      if (!result.init.ok) return;
      if (distinct) {
        expect(result.init.wctx.reviewer).not.toBe(result.init.wctx.planner);
      } else {
        expect(result.init.wctx.reviewer).toBe(result.init.wctx.planner);
      }
    });
  });

  it('initializes a new workflow from the consumed candidate v4 head', async () => {
    await withTempDir('splitbrief-init-authority-new-workflow', async (tempDir) => {
      const projectDir = realpathSync(tempDir);
      const feature = 'new fenced workflow';
      const sessionId = 'session-init-authority-new';
      const ref = { projectDir, sessionId };
      ensureSessionDir(projectDir, sessionId);

      const acquired = acquireStateAuthority({
        ref,
        purpose: 'new-workflow',
        ownerId: 'new-owner',
        runId: 'new-run',
        acquisitionId: 'new-acquisition',
      });
      expect(acquired.kind).toBe('new-workflow');
      if (acquired.kind !== 'new-workflow') return;

      const authority = consumeNewWorkflowCandidate(ref, acquired.candidate, feature);
      const initial = loadState(ref);
      expect(initial).toMatchObject({
        stateVersion: 4,
        stateRevision: 1,
        stateFence: { token: 1, ownerId: 'new-owner' },
        feature,
      });
      if (initial === null) return;

      const result = await initializeFencedWorkflow({
        projectDir,
        sessionId,
        feature,
        authority,
        savedState: initial,
        newWorkflow: true,
      });

      expect(result.init.ok).toBe(true);
      if (!result.init.ok) return;
      expect(result.init.state.stateVersion).toBe(4);
      expect(result.init.state.stateRevision).toBe(2);
      expect(result.init.state.stateFence).toEqual({
        token: 1,
        ownerId: 'new-owner',
      });
      expect(workflowAuthority(result.init.wctx)).toMatchObject({
        ownerId: 'new-owner',
        fence: 1,
        stateRevision: 2,
      });
      expect(loadState(ref)).toMatchObject({
        stateVersion: 4,
        stateRevision: 2,
        stateFence: { token: 1, ownerId: 'new-owner' },
      });
    });
  });

  it('refuses a candidate reached through a symlinked authority directory before any state is written', async () => {
    await withTempDir('splitbrief-init-authority-symlink', async (tempDir) => {
      const projectDir = realpathSync(tempDir);
      const sessionId = 'session-init-authority-symlink';
      const ref = { projectDir, sessionId };
      ensureSessionDir(projectDir, sessionId);

      const acquired = acquireStateAuthority({
        ref,
        purpose: 'new-workflow',
        ownerId: 'symlink-owner',
        runId: 'symlink-run',
        acquisitionId: 'symlink-acquisition',
      });
      expect(acquired.kind).toBe('new-workflow');
      if (acquired.kind !== 'new-workflow') return;

      const directory = stateAuthorityDirectory(ref);
      const relocated = `${directory}.relocated`;
      renameSync(directory, relocated);
      symlinkSync(relocated, directory);

      expect(() =>
        consumeNewWorkflowCandidate(ref, acquired.candidate, 'symlinked authority'),
      ).toThrow(/not a real directory/u);
      expect(loadState(ref)).toBeNull();
    });
  });

  it('promotes a v3 head before initialization and resumes only migrated v4 state', async () => {
    await withTempDir('splitbrief-init-authority-v3', async (tempDir) => {
      const projectDir = realpathSync(tempDir);
      const feature = 'promote legacy workflow';
      const sessionId = 'session-init-authority-v3';
      const ref = { projectDir, sessionId };
      ensureSessionDir(projectDir, sessionId);
      saveState(ref, {
        ...createInitialState(feature),
        stateVersion: 3,
        phase: 'reviewing-briefs',
      });

      const acquired = acquireStateAuthority({
        ref,
        purpose: 'resume',
        ownerId: 'resume-owner',
        runId: 'resume-run',
        acquisitionId: 'resume-acquisition',
      });
      expect(acquired.kind).toBe('fenced');
      if (acquired.kind !== 'fenced') return;
      expect(acquired.promotedFromVersion).toBe(3);

      const migrated = loadState(ref);
      expect(migrated).toMatchObject({
        stateVersion: 4,
        stateFence: { token: acquired.receipt.fence, ownerId: 'resume-owner' },
      });
      if (migrated === null) return;

      const resume = loadStateForResume({
        ref,
        authority: {
          kind: 'fenced',
          receipt: acquired.receipt,
          promotedFromVersion: acquired.promotedFromVersion,
        },
      });
      expect(resume).toMatchObject({ kind: 'loaded', migrated: true });

      const result = await initializeFencedWorkflow({
        projectDir,
        sessionId,
        feature,
        authority: acquired.receipt,
        savedState: migrated,
        newWorkflow: false,
      });

      expect(result.init.ok).toBe(true);
      if (!result.init.ok) return;
      expect(result.init.state.stateVersion).toBe(4);
      expect(result.init.state.stateRevision).toBe(acquired.receipt.stateRevision);
      expect(result.planner.plan).not.toHaveBeenCalled();
      expect(result.implementer.implement).not.toHaveBeenCalled();
      expect(workflowAuthority(result.init.wctx)).toMatchObject({
        fence: acquired.receipt.fence,
        stateRevision: acquired.receipt.stateRevision,
      });
    });
  });

  it('refuses a second initialization authority while the current owner is live', async () => {
    await withTempDir('splitbrief-init-authority-live-owner', async (tempDir) => {
      const projectDir = realpathSync(tempDir);
      const feature = 'live owner';
      const sessionId = 'session-init-authority-live';
      const ref = { projectDir, sessionId };
      ensureSessionDir(projectDir, sessionId);
      saveState(ref, createInitialState(feature));

      const owner = acquireStateAuthority({
        ref,
        purpose: 'resume',
        ownerId: 'live-owner',
        runId: 'live-run',
        acquisitionId: 'live-acquisition',
      });
      expect(owner.kind).toBe('fenced');
      if (owner.kind !== 'fenced') return;

      const result = await initializeFencedWorkflow({
        projectDir,
        sessionId,
        feature,
        authority: owner.receipt,
        savedState: loadState(ref) ?? undefined,
        newWorkflow: false,
      });
      expect(result.init.ok).toBe(true);

      expect(() =>
        acquireStateAuthority({
          ref,
          purpose: 'resume',
          ownerId: 'second-owner',
          runId: 'second-run',
          acquisitionId: 'second-acquisition',
        }),
      ).toThrow(/live|proven dead|claimed/u);
    });
  });

  it('takes over only a proven-dead owner and rejects the stale owner thereafter', async () => {
    await withTempDir('splitbrief-init-authority-takeover', async (tempDir) => {
      const projectDir = realpathSync(tempDir);
      const sessionId = 'session-init-authority-takeover';
      const ref = { projectDir, sessionId };
      ensureSessionDir(projectDir, sessionId);
      saveState(ref, createInitialState('take over dead owner'));

      const oldOwner = acquireStateAuthority({
        ref,
        purpose: 'resume',
        ownerId: 'old-owner',
        runId: 'old-run',
        acquisitionId: 'old-acquisition',
        pid: 2_147_483_646,
        processStart: '1',
      });
      expect(oldOwner.kind).toBe('fenced');
      if (oldOwner.kind !== 'fenced') return;

      const successor = acquireStateAuthority({
        ref,
        purpose: 'resume',
        ownerId: 'successor-owner',
        runId: 'successor-run',
        acquisitionId: 'successor-acquisition',
      });
      expect(successor.kind).toBe('fenced');
      if (successor.kind !== 'fenced') return;
      expect(successor.receipt.fence).toBe(oldOwner.receipt.fence + 1);

      const current = loadState(ref);
      expect(current).toMatchObject({
        stateRevision: oldOwner.receipt.stateRevision + 1,
        stateFence: {
          token: successor.receipt.fence,
          ownerId: 'successor-owner',
        },
      });
      if (current === null) return;

      await expect(
        initializeFencedWorkflow({
          projectDir,
          sessionId,
          feature: 'take over dead owner',
          authority: oldOwner.receipt,
          savedState: current,
          newWorkflow: false,
        }),
      ).rejects.toThrow();
      expect(loadState(ref)).toEqual(current);
    });
  });

  it('initializes the shared logger for a headless host before the event sink handles events', async () => {
    await withTempDir('splitbrief-init-headless-logger', async (projectDir) => {
      const feature = 'headless logger lifecycle';
      const sessionId = 'session-init-headless-logger';
      const events: EngineEvent[] = [];
      const bus = createEventBus();
      bus.subscribe((event) => events.push(event));

      const { init } = await initializeFencedWorkflow({
        projectDir,
        sessionId,
        feature,
        configOverrides: { workflow: { mode: 'quick', persistTranscript: true } },
        headless: true,
        eventBus: bus,
      });

      expect(init.ok).toBe(true);
      expect(events).toContainEqual(expect.objectContaining({ type: 'workflow_started' }));
      const log = await readFile(join(projectDir, '.splitbrief', 'logs', 'debug.log'), 'utf8');
      expect(log).toContain('[engine] workflow_started');
    });
  });

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
      const { init, tracked } = await initializeFencedWorkflow({
        projectDir,
        sessionId,
        feature,
      });

      expect(init.ok).toBe(true);
      expect(tracked.current?.feature).toBe(feature);
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
      const { init, tracked } = await initializeFencedWorkflow({
        projectDir,
        sessionId,
        feature,
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
      });

      expect(init.ok).toBe(true);
      expect(tracked.current?.selectedSkills).toEqual(['typescript', 'react']);
      expect(loadState({ projectDir, sessionId })?.selectedSkills).toEqual(['typescript', 'react']);
    });
  });

  it('surfaces the api provider cause when an api planner is unavailable', async () => {
    await withTempDir('splitbrief-init-api-unavailable', async (projectDir) => {
      const feature = 'needs a reachable provider';
      const sessionId = 'session-init-api-unavailable';
      const events: EngineEvent[] = [];

      const { init } = await initializeFencedWorkflow({
        projectDir,
        sessionId,
        feature,
        configOverrides: {
          planner: {
            kind: 'api',
            provider: 'custom-endpoint',
            model: 'some-model',
            apiBase: 'https://api.example.com/v1',
            apiKey: 'k',
          },
        },
        plannerTool: 'custom-endpoint',
        plannerRunner: makePlanner({
          isAvailable: vi.fn().mockResolvedValue(false),
          unavailabilityReason: () => 'HTTP 401',
        }),
        eventSink: (e) => events.push(e),
      });

      expect(init.ok).toBe(false);
      const errorEvent = events.find(
        (e): e is Extract<EngineEvent, { type: 'error' }> => e.type === 'error',
      );
      expect(errorEvent?.message).toContain("Planner 'custom-endpoint' is not available");
      expect(errorEvent?.message).toContain('HTTP 401');
      expect(errorEvent?.message).not.toContain("Make sure it's installed");
    });
  });

  it('does not publish a planner_status fallback when resuming an implementer phase', async () => {
    await withTempDir('splitbrief-init-resume-implementing', async (projectDir) => {
      const feature = 'resume implementation';
      const sessionId = 'session-init-resume-implementing';
      const events: EngineEvent[] = [];

      const { init } = await initializeFencedWorkflow({
        projectDir,
        sessionId,
        feature,
        savedState: { ...createInitialState(feature), phase: 'implementing' },
        eventSink: (e) => events.push(e),
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

  it('recovers interrupted native delivery only when a saved workflow is resumed', async () => {
    await withTempDir('splitbrief-init-resume-native-delivery', async (projectDir) => {
      const feature = 'resume interrupted native delivery';
      const sessionId = 'session-init-resume-native-delivery';
      const savedState: WorkflowState = {
        ...createInitialState(feature),
        phase: 'implementing',
        messageQueue: [
          {
            id: 'interrupted-native-message',
            text: 'retry after process restart',
            queuedAt: new Date(0).toISOString(),
            phase: 'implementing',
            deliveredViaNative: false,
            nativeDeliveryState: 'injecting',
          },
        ],
      };
      const { init, tracked } = await initializeFencedWorkflow({
        projectDir,
        sessionId,
        feature,
        savedState,
      });

      expect(init.ok).toBe(true);
      expect(tracked.current?.messageQueue[0]?.nativeDeliveryState).toBe('pending');
      expect(loadState({ projectDir, sessionId })?.messageQueue[0]?.nativeDeliveryState).toBe(
        'pending',
      );
    });
  });

  it('cli planner without a reason keeps the install hint', async () => {
    await withTempDir('splitbrief-init-cli-unavailable', async (projectDir) => {
      const feature = 'needs an installed cli';
      const sessionId = 'session-init-cli-unavailable';
      const events: EngineEvent[] = [];

      const { init } = await initializeFencedWorkflow({
        projectDir,
        sessionId,
        feature,
        configOverrides: { planner: { kind: 'cli', tool: 'claude-code' } },
        plannerTool: 'claude-code',
        plannerRunner: makePlanner({ isAvailable: vi.fn().mockResolvedValue(false) }),
        eventSink: (e) => events.push(e),
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
      const events: EngineEvent[] = [];

      const { init } = await initializeFencedWorkflow({
        projectDir,
        sessionId,
        feature,
        configOverrides: { planner: { kind: 'cli', tool: 'claude-code' } },
        plannerTool: 'claude-code',
        plannerRunner: makePlanner({
          isAvailable: vi.fn().mockResolvedValue(false),
          unavailabilityReason: () => 'probe timed out after 5s',
        }),
        eventSink: (e) => events.push(e),
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
      const { init, config } = await initializeFencedWorkflow({
        projectDir,
        sessionId,
        feature,
        configOverrides: {
          validation: {
            typecheck: true,
            lint: false,
            test: false,
            typecheckCommand: 'node -e "process.exit(1)"',
          },
        },
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
      expect(error).toContain('typecheck');
    });
  });

  it('carries the run-scoped isolation handle on the workflow context', async () => {
    await withTempDir('splitbrief-init-isolation', async (projectDir) => {
      const feature = 'carry isolation handle';
      const sessionId = 'session-init-isolation';
      const isolation = makeCopyingIsolation(projectDir, sessionId);

      const { init } = await initializeFencedWorkflow({
        projectDir,
        sessionId,
        feature,
        isolation,
      });

      expect(init.ok).toBe(true);
      if (!init.ok) return;
      expect(init.wctx.isolation).toBe(isolation);
    });
  });

  it('publishes one compiler version drift warning', async () => {
    await withTempDir('splitbrief-init-drift-warning', async (projectDir) => {
      const feature = 'drift warning';
      const sessionId = 'session-init-drift-warning';
      const events: EngineEvent[] = [];
      const planner = makePlanner();
      installCompilerSeam(planner, makeCompilerSeam({ backend: 'opencode' }));

      const { init } = await initializeFencedWorkflow({
        projectDir,
        sessionId,
        feature,
        plannerTool: 'opencode',
        plannerRunner: planner,
        eventSink: (e) => events.push(e),
      });

      expect(init.ok).toBe(true);
      const warnings = events.filter((e) => e.type === 'warning');
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.message).toBe(
        'planner opencode 1.19.0 differs from the tested 1.18.15; compiled with runtime-drift evidence',
      );
    });
  });

  it('suppresses the warning when the cache holds the version', async () => {
    await withTempDir('splitbrief-init-drift-suppressed', async (projectDir) => {
      recordRuntimeConformance(projectDir, { backend: 'opencode', version: '1.19.0' });

      const feature = 'drift warning suppressed';
      const sessionId = 'session-init-drift-suppressed';
      const events: EngineEvent[] = [];
      const planner = makePlanner();
      installCompilerSeam(planner, makeCompilerSeam({ backend: 'opencode' }));

      const { init } = await initializeFencedWorkflow({
        projectDir,
        sessionId,
        feature,
        plannerTool: 'opencode',
        plannerRunner: planner,
        eventSink: (e) => events.push(e),
      });

      expect(init.ok).toBe(true);
      const warnings = events.filter((e) => e.type === 'warning');
      expect(warnings).toHaveLength(0);
    });
  });
});
