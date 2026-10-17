import { plainUserMessage } from '../../../core/types/user-input.js';

import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { useTrustHome } from '#testing/helpers/trust-home.js';
import {
  makeCallbacks,
  makeImplementer,
  makePlanner,
} from '#testing/helpers/orchestrator-factories.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeRecoveryIssue } from '#testing/helpers/factories/recovery.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makePreparedExecution } from '#testing/helpers/factories/prepared-execution.js';
import { makeRunnerGate } from '#testing/helpers/runner-gate.js';
import { createInitialState } from '../../../core/state/machine.js';
import type { Config } from '../../../core/schemas/config.js';
import type { AttachedInput } from '../../../core/schemas/attachment.js';
import type { SpecMetadata } from '../../../core/paths-io.js';
import { ensureSessionDir } from '../../../core/paths-io.js';
import { appendMessage } from '../../../core/sessions/log-writer.js';
import type { ResumeContextHolder } from '../types.js';
import { reactivateExistingSession } from '../../../core/sessions/active-pointer.js';
import { resolveImplementerProfiles } from '../../../core/config/accessors/implementer-profiles.js';
import { configuredReviewerRunner } from '../../../core/config/accessors/reviewer-runner.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { RecoveryIssue } from '../../../core/schemas/recovery/schemas.js';
import { taskId, type Task } from '../../../core/schemas/task.js';
import type { SkillMeta } from '../../../core/skills/types.js';
import type { EngineEvent, EventBus } from '../../events/types.js';
import { createEventBus } from '../../events/bus.js';
import { readRunEvents } from '../../events/replay.js';
import { loadState, saveState } from '../../../core/state/persistence.js';
import { createEvidenceLedger } from '../../../core/evidence/ledger-state.js';
import { writeEvidenceLedger } from '../../../core/evidence/ledger-storage.js';
import { hashTaskBrief } from '../../../core/evidence/brief-hash.js';
import { sha256Hex } from '../../../utils/sha256.js';
import {
  captureChangedFilesBaseline,
  serializeChangedFilesBaseline,
} from '../changed-files-baseline.js';
import {
  readSeatIdentities,
  seatIdentitiesFromConfig,
  writeSeatIdentities,
} from '../../../core/state/seats.js';
import type { SummaryBase } from '../summary/build.js';
import { initializeWorkflow } from './init.js';
import { createPlannerSeat } from './init-seats.js';
import { createRunIsolation } from '../isolation/create.js';
import type { RunIsolation } from '../isolation/types.js';
import { parsePreparedConfig, type PreparedExecution } from '../../runners/prepared-execution.js';
import { markHooksConfigTrusted } from '../../../core/hooks/trust.js';
import { loadConfig, writeConfig } from '../../../core/config/load/io.js';
import { configWithSwitchedSeat } from '../recovery/switch-seat.js';
import { switchSeatAndPrepareResume } from '../recovery/switch-seat-resume.js';
import { createRecoveryBus } from '../recovery/bus.js';
import { buildRepoChecks } from '../../../core/readiness/checks/repo.js';
import type { ReadinessReport } from '../../../core/readiness/types.js';

vi.mock('./init-seats.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./init-seats.js')>();
  return { ...actual, createPlannerSeat: vi.fn(actual.createPlannerSeat) };
});

function makeCopyingIsolation(projectDir: string, sessionId: string): RunIsolation {
  return createRunIsolation({
    projectDir,
    sessionId,
    strategy: 'staged-copy',
    onFallback: () => {},
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
    plannerContext?: string | undefined;
    attachedInputs?: readonly AttachedInput[];
    report?: ReadinessReport;
  }>,
): Promise<Readonly<{ config: Config; execution: PreparedExecution }>> {
  const hooks = input.inputConfig.hooks;
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
      report: input.report ?? {
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
        ...(input.plannerContext !== undefined && { plannerContext: input.plannerContext }),
        ...(input.attachedInputs !== undefined && { attachedInputs: input.attachedInputs }),
      },
    },
  };
}

async function initializeTestWorkflow(
  input: Readonly<{
    projectDir: string;
    sessionId: string;
    feature: string;
    steer?: ReturnType<typeof plainUserMessage> | undefined;
    savedState?: WorkflowState | undefined;
    newWorkflow?: boolean;
    reviewer?: Config['reviewer'];
    configOverrides?: Parameters<typeof makeConfig>[0];
    plannerTool?: string;
    plannerKind?: SummaryBase['plannerKind'];
    implementerKind?: SummaryBase['implementerKind'];
    plannerRunner?: ReturnType<typeof makePlanner>;
    selectedSkills?: SkillMeta[];
    eventSink?: (event: EngineEvent) => void;
    eventBus?: EventBus;
    signal?: AbortSignal;
    headless?: boolean;
    isolation?: RunIsolation;
    plannerContext?: string | undefined;
    attachedInputs?: readonly AttachedInput[];
    resumeHolder?: ResumeContextHolder;
    report?: ReadinessReport;
  }>,
): Promise<{
  init: Awaited<ReturnType<typeof initializeWorkflow>>;
  config: Config;
  planner: ReturnType<typeof makePlanner>;
  implementer: ReturnType<typeof makeImplementer>;
  tracked: { current: WorkflowState | undefined };
}> {
  const config = makeConfig({
    validation: { endChecks: false, testCommand: 'noop' },
    workflow: {},
    approval: { feedRejectionsToPlanner: true },
    codebase: { enabled: false, tokenBudget: 4000 },
    ...(input.reviewer === undefined ? {} : { reviewer: input.reviewer }),
    ...input.configOverrides,
  });
  const prepared = await preparedTestExecution({
    projectDir: input.projectDir,
    sessionId: input.sessionId,
    feature: input.feature,
    inputConfig: config,
    allowHooks: true,
    ...(input.plannerContext !== undefined && { plannerContext: input.plannerContext }),
    ...(input.attachedInputs !== undefined && { attachedInputs: input.attachedInputs }),
    ...(input.report !== undefined && { report: input.report }),
  });
  const planner = input.plannerRunner ?? makePlanner();
  const implementer = makeImplementer();
  const plannerTool = input.plannerTool ?? 'test-planner';
  const summaryBase: SummaryBase = {
    feature: input.feature,
    startTime: Date.now(),
    plannerTool,
    ...(input.plannerKind !== undefined && { plannerKind: input.plannerKind }),
    implementerTool: 'test-implementer',
    ...(input.implementerKind !== undefined && { implementerKind: input.implementerKind }),
    projectDir: input.projectDir,
    sessionId: input.sessionId,
  };
  const metadata: SpecMetadata = {
    planner: `${plannerTool} · auto`,
    implementer: 'test-implementer · auto',
    reviewer: `${plannerTool} · auto`,
  };
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
      signal: input.signal,
      _planner: planner,
      _implementer: implementer,
      _eventSink: input.eventSink,
      ...(input.steer !== undefined && { steer: input.steer }),
    },
    config: prepared.config,
    sessionId: input.sessionId,
    summaryBase,
    metadata,
    setTrackedState: (state) => {
      tracked.current = state;
    },
    resumeHolder: input.resumeHolder ?? { messages: [] },
    isolation: input.isolation ?? makeCopyingIsolation(input.projectDir, input.sessionId),
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
  vi.useRealTimers();
  trustHome.restore();
});

describe('initializeWorkflow', () => {
  it('records recovery re-entry under the same signal, but a fresh restart has no marker', async () => {
    await withTempDir('splitbrief-init-clock-continuation', async (projectDir) => {
      const sessionId = 'clock-continuation';
      const feature = 'continue the run';
      const events: EngineEvent[] = [];
      const signal = new AbortController().signal;
      const input = {
        projectDir,
        sessionId,
        feature,
        signal,
        eventSink: (event: EngineEvent) => events.push(event),
      };
      const started = await initializeTestWorkflow(input);
      if (!started.init.ok) throw new Error('Expected run start');
      const savedState = { ...started.init.state, phase: 'implementing' } as const;
      const continued = await initializeTestWorkflow({ ...input, savedState });
      expect(continued.init.ok).toBe(true);
      const restarted = await initializeTestWorkflow({
        ...input,
        savedState,
        signal: new AbortController().signal,
      });
      expect(restarted.init.ok).toBe(true);
      const resumed = events.filter((event) => event.type === 'workflow_resumed');
      expect(resumed).toHaveLength(2);
      expect(resumed[0]).toMatchObject({ inProcess: true });
      expect(resumed[1]).not.toHaveProperty('inProcess');
      const replay = await readRunEvents({ projectDir, sessionId });
      expect(replay.events.filter((event) => event.type === 'workflow_resumed')).toEqual(resumed);
    });
  });

  it.each<{ name: string; attachedInputs?: readonly AttachedInput[] }>([
    {
      name: 'with attached inputs',
      attachedInputs: [
        { path: '/Users/dev/briefs/feature.md', kind: 'text' },
        { path: '/Users/dev/Desktop/receiving-flow.png', kind: 'image' },
      ],
    },
    { name: 'without attached inputs' },
    { name: 'with an empty attached-input list', attachedInputs: [] },
  ])('publishes and replays the first request $name', async ({ attachedInputs }) => {
    await withTempDir('splitbrief-init-attached-inputs', async (tempDir) => {
      const projectDir = realpathSync(tempDir);
      const sessionId = 'session-init-attached-inputs';
      const feature = 'plan the receiving workflow';
      const events: EngineEvent[] = [];

      const { init } = await initializeTestWorkflow({
        projectDir,
        sessionId,
        feature,
        eventSink: (event) => events.push(event),
        ...(attachedInputs !== undefined && { attachedInputs }),
      });

      expect(init.ok).toBe(true);
      const messages = events.filter((event) => event.type === 'user_message');
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({ text: feature });
      if (attachedInputs !== undefined && attachedInputs.length > 0) {
        expect(messages[0]).toHaveProperty('attachedInputs', attachedInputs);
      } else {
        expect(messages[0]).not.toHaveProperty('attachedInputs');
      }
      const replay = await readRunEvents({ projectDir, sessionId });
      expect(replay.events.filter((event) => event.type === 'user_message')).toEqual(messages);
    });
  });

  describe('start readiness warnings', () => {
    function dirtyCheckoutReport(projectDir: string): ReadinessReport {
      return {
        generatedAt: new Date(0).toISOString(),
        projectDir,
        status: 'ready-with-warnings',
        counts: { ok: 0, info: 0, warning: 1, blocker: 0 },
        nextAction: { kind: 'continue', label: 'Continue', reason: 'warnings' },
        sections: [
          {
            id: 'repo',
            title: 'Repository',
            checks: buildRepoChecks(
              { isGitRepo: true, hasCommits: true, dirtyFiles: ['README.md'], untrackedFiles: [] },
              'none',
            ),
          },
        ],
        metadata: {},
      };
    }

    it('states a readiness warning with its details and fix under the request of a new run', async () => {
      await withTempDir('splitbrief-init-start-warning', async (tempDir) => {
        const projectDir = realpathSync(tempDir);
        const sessionId = 'session-init-start-warning';
        const events: EngineEvent[] = [];

        const { init } = await initializeTestWorkflow({
          projectDir,
          sessionId,
          feature: 'fix the readme',
          report: dirtyCheckoutReport(projectDir),
          eventSink: (event) => events.push(event),
        });

        expect(init.ok).toBe(true);
        const warnings = events.filter((event) => event.type === 'warning');
        expect(warnings).toHaveLength(1);
        expect(warnings[0]?.message.split('\n')).toEqual([
          'Working tree has 1 changed file.',
          'Examples: README.md',
          'An attempt revert restores only the paths that attempt changed.',
          `Fix: The run edits this checkout. A revert saves the files it replaces in .splitbrief/sessions/${sessionId}/reverted/. Commit or stash the edits you do not want this run to touch.`,
        ]);
        const request = events.findIndex((event) => event.type === 'user_message');
        expect(request).toBeGreaterThanOrEqual(0);
        expect(events.indexOf(warnings[0] as EngineEvent)).toBe(request + 1);
        const replay = await readRunEvents({ projectDir, sessionId });
        expect(replay.events.filter((event) => event.type === 'warning')).toEqual(warnings);
      });
    });

    it('states nothing for a start readiness found ready', async () => {
      await withTempDir('splitbrief-init-start-ready', async (projectDir) => {
        const events: EngineEvent[] = [];
        const { init } = await initializeTestWorkflow({
          projectDir,
          sessionId: 'session-init-start-ready',
          feature: 'fix the readme',
          eventSink: (event) => events.push(event),
        });
        expect(init.ok).toBe(true);
        expect(events.filter((event) => event.type === 'warning')).toEqual([]);
      });
    });

    it('does not restate the start warnings when a run continues', async () => {
      await withTempDir('splitbrief-init-start-warning-resume', async (projectDir) => {
        const feature = 'fix the readme';
        const events: EngineEvent[] = [];
        const { init } = await initializeTestWorkflow({
          projectDir,
          sessionId: 'session-init-start-warning-resume',
          feature,
          report: dirtyCheckoutReport(projectDir),
          savedState: { ...createInitialState(feature), phase: 'planning' },
          eventSink: (event) => events.push(event),
        });
        expect(init.ok).toBe(true);
        expect(events).toContainEqual(expect.objectContaining({ type: 'workflow_resumed' }));
        expect(events.filter((event) => event.type === 'warning')).toEqual([]);
      });
    });
  });

  it('does not attach the start inputs to a continuation message', async () => {
    await withTempDir('splitbrief-init-continued-inputs', async (tempDir) => {
      const projectDir = realpathSync(tempDir);
      const feature = 'plan the receiving workflow';
      const events: EngineEvent[] = [];

      const { init } = await initializeTestWorkflow({
        projectDir,
        sessionId: 'session-init-continued-inputs',
        feature,
        attachedInputs: [{ path: '/Users/dev/briefs/feature.md', kind: 'text' }],
        steer: plainUserMessage('include the receiving screen'),
        savedState: { ...createInitialState(feature), phase: 'planning' },
        eventSink: (event) => events.push(event),
      });

      expect(init.ok).toBe(true);
      const messages = events.filter((event) => event.type === 'user_message');
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({ text: 'include the receiving screen' });
      expect(messages[0]).not.toHaveProperty('attachedInputs');
    });
  });

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
      ensureSessionDir(projectDir, sessionId);

      const result = await initializeTestWorkflow({
        projectDir,
        sessionId,
        feature,
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

  it('initializes the shared logger for a headless host before the event sink handles events', async () => {
    await withTempDir('splitbrief-init-headless-logger', async (projectDir) => {
      const feature = 'headless logger lifecycle';
      const sessionId = 'session-init-headless-logger';
      const events: EngineEvent[] = [];
      const bus = createEventBus();
      bus.subscribe((event) => events.push(event));

      const { init } = await initializeTestWorkflow({
        projectDir,
        sessionId,
        feature,
        configOverrides: { workflow: {} },
        headless: true,
        eventBus: bus,
      });

      expect(init.ok).toBe(true);
      expect(events).toContainEqual(expect.objectContaining({ type: 'workflow_started' }));
      const log = await readFile(join(projectDir, '.splitbrief', 'logs', 'debug.log'), 'utf8');
      expect(log).toContain('[engine] workflow_started');
    });
  });

  it('names a project that has no package.json name after its directory', async () => {
    await withTempDir('splitbrief-init-project-name', async (projectDir) => {
      const { init } = await initializeTestWorkflow({
        projectDir,
        sessionId: 'session-init-project-name',
        feature: 'name the project',
      });

      expect(init.ok).toBe(true);
      if (!init.ok) return;
      expect(init.wctx.context.name).toBe(basename(projectDir));
    });
  });

  it('persists the selected skill ids in the initial workflow state on a fresh run', async () => {
    await withTempDir('splitbrief-init-skills', async (projectDir) => {
      const feature = 'feature needing skills';
      const sessionId = 'session-init-skills';
      const { init, tracked } = await initializeTestWorkflow({
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

  it('rebuilds the saved skills for every seat of a run continued past planning', async () => {
    await withTempDir('splitbrief-init-skills-continue', async (tempDir) => {
      const projectDir = realpathSync(tempDir);
      const feature = 'continue with skills';
      const sessionId = 'session-init-skills-continue';
      const skillDir = join(projectDir, '.claude', 'skills', 'auth-skill');
      mkdirSync(join(skillDir, 'references'), { recursive: true });
      writeFileSync(
        join(skillDir, 'SKILL.md'),
        '---\nname: AuthSkill\ndescription: d\n---\nAUTH-BODY',
      );
      writeFileSync(join(skillDir, 'references', 'tokens.md'), 'TOKENS-REFERENCE');

      const { init } = await initializeTestWorkflow({
        projectDir,
        sessionId,
        feature,
        savedState: {
          ...createInitialState(feature),
          phase: 'implementing',
          selectedSkills: ['auth-skill'],
        },
      });

      expect(init.ok).toBe(true);
      if (!init.ok) return;
      const skills = init.wctx.context.skillsContext;
      expect(skills).toContain('### AuthSkill');
      expect(skills).toContain(
        'Base directory: .claude/skills/auth-skill (relative to the project root)',
      );
      expect(skills).toContain('AUTH-BODY');
      expect(skills).toContain('#### references/tokens.md\nTOKENS-REFERENCE');
    });
  });

  it("builds the planner and reviewer seats with the run's global skills", async () => {
    await withTempDir('splitbrief-init-skills-seats', async (tempDir) => {
      const projectDir = realpathSync(tempDir);
      const feature = 'continue with a global skill';
      const globalSkill = join(trustHome.home, '.claude', 'skills', 'global-skill');
      mkdirSync(globalSkill, { recursive: true });
      writeFileSync(join(globalSkill, 'SKILL.md'), '---\nname: GlobalSkill\n---\nGLOBAL-BODY');

      const { init } = await initializeTestWorkflow({
        projectDir,
        sessionId: 'session-init-skills-seats',
        feature,
        savedState: {
          ...createInitialState(feature),
          phase: 'implementing',
          selectedSkills: ['global-skill'],
        },
      });

      expect(init.ok).toBe(true);
      expect(createPlannerSeat).toHaveBeenCalledWith(
        expect.objectContaining({ skillRoots: [realpathSync(globalSkill)] }),
      );
    });
  });

  it('records the ids of the skills the seats carry on the run config event', async () => {
    await withTempDir('splitbrief-init-skills-record', async (tempDir) => {
      const projectDir = realpathSync(tempDir);
      const skillDir = join(projectDir, '.claude', 'skills', 'auth-skill');
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(
        join(skillDir, 'SKILL.md'),
        '---\nname: AuthSkill\ndescription: d\n---\nAUTH-BODY',
      );
      const events: EngineEvent[] = [];

      const { init } = await initializeTestWorkflow({
        projectDir,
        sessionId: 'session-init-skills-record',
        feature: 'record the skills',
        selectedSkills: [
          {
            id: 'auth-skill',
            name: 'AuthSkill',
            description: 'd',
            path: join(skillDir, 'SKILL.md'),
            scope: 'project',
            projectDir,
          },
        ],
        eventSink: (event) => events.push(event),
      });

      expect(init.ok).toBe(true);
      expect(events).toContainEqual(
        expect.objectContaining({ type: 'workflow_config', skills: ['auth-skill'] }),
      );
    });
  });

  it('signals skills_truncated when the selected skills overflow the budget', async () => {
    await withTempDir('splitbrief-init-skills-budget', async (tempDir) => {
      const projectDir = realpathSync(tempDir);
      const sessionId = 'session-init-skills-budget';
      const skillDir = join(projectDir, '.claude', 'skills', 'huge');
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, 'SKILL.md'), `---\nname: Huge\n---\n${'h'.repeat(20_000)}`);
      const events: EngineEvent[] = [];

      const { init } = await initializeTestWorkflow({
        projectDir,
        sessionId,
        feature: 'overflow the skills budget',
        selectedSkills: [
          {
            id: 'huge',
            name: 'Huge',
            description: '',
            path: join(skillDir, 'SKILL.md'),
            scope: 'project',
            projectDir,
          },
        ],
        eventSink: (event) => events.push(event),
      });

      expect(init.ok).toBe(true);
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'warning',
          code: 'skills_truncated',
          message: '1 skill over the skills budget, named by path: Huge',
        }),
      );
    });
  });

  it('surfaces the api provider cause when an api planner is unavailable', async () => {
    await withTempDir('splitbrief-init-api-unavailable', async (projectDir) => {
      const feature = 'needs a reachable provider';
      const sessionId = 'session-init-api-unavailable';
      const events: EngineEvent[] = [];

      const { init } = await initializeTestWorkflow({
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

  it('keeps the partial of an old run cut mid-research in the planner context it continues with', async () => {
    await withTempDir('splitbrief-init-old-cut-research', async (projectDir) => {
      const feature = 'old cut research';
      const sessionId = 'session-init-old-cut-research';
      ensureSessionDir(projectDir, sessionId);
      const ref = { projectDir, sessionId };
      appendMessage(ref, { role: 'user', phase: 'researching', text: 'Plan the greeting' });
      appendMessage(ref, {
        role: 'assistant',
        phase: 'researching',
        text: 'PARTIAL-RESEARCH so far',
        interrupted: true,
      });
      const resumeHolder: ResumeContextHolder = { messages: [] };

      const { init } = await initializeTestWorkflow({
        projectDir,
        sessionId,
        feature,
        resumeHolder,
        savedState: {
          ...createInitialState(feature),
          phase: 'researching',
          mode: 'standard',
          awaitingContinue: true,
          interruptedStep: {
            step: { kind: 'planner', call: 'research' },
            source: 'user',
            cut: 'mid-step',
            at: new Date(0).toISOString(),
          },
        },
      });

      expect(init.ok).toBe(true);
      expect(JSON.stringify(resumeHolder.messages)).toContain('PARTIAL-RESEARCH so far');
    });
  });

  it('does not publish a planner_status fallback when resuming an implementer phase', async () => {
    await withTempDir('splitbrief-init-resume-implementing', async (projectDir) => {
      const feature = 'resume implementation';
      const sessionId = 'session-init-resume-implementing';
      const events: EngineEvent[] = [];

      const { init } = await initializeTestWorkflow({
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

  it('cli planner without a reason keeps the install hint', async () => {
    await withTempDir('splitbrief-init-cli-unavailable', async (projectDir) => {
      const feature = 'needs an installed cli';
      const sessionId = 'session-init-cli-unavailable';
      const events: EngineEvent[] = [];

      const { init } = await initializeTestWorkflow({
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

      const { init } = await initializeTestWorkflow({
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

  it('carries the run-scoped isolation handle on the workflow context', async () => {
    await withTempDir('splitbrief-init-isolation', async (projectDir) => {
      const feature = 'carry isolation handle';
      const sessionId = 'session-init-isolation';
      const isolation = makeCopyingIsolation(projectDir, sessionId);

      const { init } = await initializeTestWorkflow({
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

  it('seeds a correction typed at a task halt into the reset brief at attempt 0, once', async () => {
    await withTempDir('splitbrief-init-halt-steer', async (projectDir) => {
      createTestGitRepo(projectDir);
      const feature = 'ship the banner';
      const events: EngineEvent[] = [];
      // The state retry-same-worker leaves: RESET_TASK put T001 back at attempt 0 and cleared the halt.
      const result = await initializeTestWorkflow({
        projectDir,
        sessionId: 'session-init-halt-steer',
        feature,
        steer: plainUserMessage('use the registry'),
        eventSink: (event) => events.push(event),
        savedState: {
          ...createInitialState(feature),
          phase: 'implementing',
          tasks: [makeTask({ id: 'T001', status: 'pending', suggestedFiles: ['src/banner.ts'] })],
          currentTaskIndex: 0,
          attempt: 0,
        },
      });

      expect(result.init.ok).toBe(true);
      if (!result.init.ok) return;
      expect(
        result.init.wctx.continuation?.take({ kind: 'brief', taskId: taskId('T001'), attempt: 0 }),
      ).toEqual({ steer: plainUserMessage('use the registry') });
      expect(
        events.filter(
          (event) => event.type === 'user_message' && event.text === 'use the registry',
        ),
      ).toHaveLength(1);
    });
  });

  it('waits for a persisted seat reset before the task continues', async () => {
    await withTempDir('splitbrief-init-seat-wait', async (tempDir) => {
      const projectDir = realpathSync(tempDir);
      const feature = 'resume during a seat wait';
      const sessionId = 'session-init-seat-wait';
      ensureSessionDir(projectDir, sessionId);
      const events: EngineEvent[] = [];
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

      const pending = initializeTestWorkflow({
        projectDir,
        sessionId,
        feature,
        eventSink: (event) => events.push(event),
        savedState: {
          ...createInitialState(feature),
          phase: 'implementing',
          tasks: [makeTask({ id: 'T001', status: 'pending', suggestedFiles: ['src/banner.ts'] })],
          currentTaskIndex: 0,
          seatWait: { seat: 'build', resetAt: '2026-01-01T02:00:00.000Z' },
        },
      });
      let settled = false;
      void pending.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      // Let init reach the persisted wait without moving the clock past it.
      while (!settled && !events.some((event) => event.type === 'seat_wait_started')) {
        await vi.advanceTimersByTimeAsync(1);
      }
      expect(events.filter((event) => event.type === 'seat_wait_started')).toHaveLength(1);

      while (!settled) {
        await vi.advanceTimersByTimeAsync(vi.getTimerCount() === 0 ? 1 : 7_200_000);
      }
      const { init } = await pending;

      expect(init.ok).toBe(true);
      expect(loadState({ projectDir, sessionId })?.seatWait).toBeUndefined();
    });
  });
});

describe('initializeWorkflow — a task interrupted mid-gate', () => {
  it.each(['worktree', 'staged-copy'] as const)(
    'restores the interrupted brief in its recorded %s and preserves checkout edits',
    async (strategy) => {
      await withTempDir('splitbrief-init-interrupted-worktree', async (projectDir) => {
        createTestGitRepo(projectDir, { 'src/two.ts': 'original' });
        const feature = 'resume in the run workspace';
        const sessionId = 'session-init-interrupted-worktree';
        const config = makeConfig();
        const isolation = createRunIsolation({
          projectDir,
          sessionId,
          strategy,
          onFallback: () => {},
        });
        try {
          const workspace = await isolation.open({ config });
          expect(workspace.kind).toBe(strategy);
          writeFileSync(join(workspace.projectDir, 'src/two.ts'), 'pre-task input');
          const snapshot = (await isolation.acquire({ role: 'implementer', config })).snapshot;
          writeFileSync(join(workspace.projectDir, 'src/two.ts'), 'half written by the killed run');
          writeFileSync(join(projectDir, 'src/two.ts'), 'operator edit');
          const task = makeTask({
            id: 'T001',
            status: 'in_progress',
            suggestedFiles: ['src/two.ts'],
          });
          const { init, tracked } = await initializeTestWorkflow({
            projectDir,
            sessionId,
            feature,
            isolation,
            savedState: {
              ...createInitialState(feature),
              phase: 'validating-task',
              tasks: [task],
              currentTaskIndex: 0,
              attempt: 2,
              workspace: {
                kind: workspace.kind,
                path: workspace.projectDir,
                base: { snapshotId: 'baseline', head: workspace.head },
              },
              changedFilesBaseline: { head: null, fingerprints: {}, activeTaskSnapshot: snapshot },
            },
          });

          expect(init.ok).toBe(true);
          expect(tracked.current).toMatchObject({
            phase: 'implementing',
            attempt: 0,
            tasks: [{ id: 'T001', status: 'pending' }],
          });
          expect(readFileSync(join(workspace.projectDir, 'src/two.ts'), 'utf8')).toBe(
            'pre-task input',
          );
          expect(readFileSync(join(projectDir, 'src/two.ts'), 'utf8')).toBe('operator edit');
        } finally {
          await isolation.dispose();
        }
      });
    },
  );

  it('restarts the in-flight brief and restores its files from the task-start snapshot', async () => {
    await withTempDir('splitbrief-init-interrupted-task', async (projectDir) => {
      createTestGitRepo(projectDir, { 'src/two.ts': 'original' });
      writeFileSync(join(projectDir, 'src/two.ts'), 'half written by the killed run');
      const feature = 'resume the interrupted brief';
      const sessionId = 'session-init-interrupted-task';
      const task = makeTask({ id: 'T001', status: 'in_progress', suggestedFiles: ['src/two.ts'] });

      const { init, tracked } = await initializeTestWorkflow({
        projectDir,
        sessionId,
        feature,
        savedState: {
          ...createInitialState(feature),
          phase: 'validating-task',
          tasks: [task],
          currentTaskIndex: 0,
          attempt: 2,
          changedFilesBaseline: {
            head: null,
            fingerprints: {},
            activeTaskSnapshot: {
              head: 'HEAD',
              files: ['src/two.ts'],
              dirtyFileContents: { 'src/two.ts': 'original' },
            },
          },
        },
      });

      expect(init.ok).toBe(true);
      expect(tracked.current).toMatchObject({
        phase: 'implementing',
        attempt: 0,
        currentTaskIndex: 0,
        tasks: [{ id: 'T001', status: 'pending' }],
      });
      expect(readFileSync(join(projectDir, 'src/two.ts'), 'utf-8')).toBe('original');
      expect(loadState({ projectDir, sessionId })?.phase).toBe('implementing');
    });
  });

  it('a file the operator edited after the kill is not restored', async () => {
    await withTempDir('splitbrief-init-operator-edit', async (projectDir) => {
      createTestGitRepo(projectDir, { 'src/two.ts': 'original', 'src/operator.ts': 'original' });
      writeFileSync(join(projectDir, 'src/two.ts'), 'half written by the killed run');
      writeFileSync(join(projectDir, 'src/operator.ts'), 'edited by the operator after the kill');
      const feature = 'resume without clobbering the operator';
      const sessionId = 'session-init-operator-edit';
      const task = makeTask({ id: 'T001', status: 'in_progress', suggestedFiles: ['src/two.ts'] });
      const events: EngineEvent[] = [];

      const { init } = await initializeTestWorkflow({
        projectDir,
        sessionId,
        feature,
        eventSink: (event) => events.push(event),
        savedState: {
          ...createInitialState(feature),
          phase: 'validating-task',
          tasks: [task],
          currentTaskIndex: 0,
          changedFilesBaseline: {
            head: null,
            fingerprints: {},
            activeTaskSnapshot: {
              head: 'HEAD',
              files: ['src/two.ts', 'src/operator.ts'],
              dirtyFileContents: { 'src/two.ts': 'original', 'src/operator.ts': 'original' },
            },
          },
        },
      });

      expect(init.ok).toBe(true);
      expect(readFileSync(join(projectDir, 'src/operator.ts'), 'utf-8')).toBe(
        'edited by the operator after the kill',
      );
      expect(readFileSync(join(projectDir, 'src/two.ts'), 'utf-8')).toBe('original');
      // A run without a workspace worked in the checkout, so the restore saved what it replaced.
      expect(
        events
          .filter((e): e is Extract<EngineEvent, { type: 'warning' }> => e.type === 'warning')
          .map((e) => e.message),
      ).toContainEqual(
        expect.stringMatching(
          /^Restored 1 unfinished change\(s\) from the interrupted T001: src\/two\.ts\. The replaced bytes are in \.splitbrief\/sessions\/session-init-operator-edit\/reverted\//,
        ),
      );
    });
  });
  it('restores an unplanned file the interrupted brief promoted, as well as its declared files', async () => {
    await withTempDir('splitbrief-init-unplanned-promotion', async (projectDir) => {
      createTestGitRepo(projectDir, { 'src/two.ts': 'original', 'src/shared.ts': 'original' });
      writeFileSync(join(projectDir, 'src/two.ts'), 'half written by the killed run');
      writeFileSync(join(projectDir, 'src/shared.ts'), 'promoted by the killed run');
      const feature = 'resume a brief that touched an unplanned file';
      const sessionId = 'session-init-unplanned-promotion';
      const task = makeTask({ id: 'T001', status: 'in_progress', suggestedFiles: ['src/two.ts'] });
      ensureSessionDir(projectDir, sessionId);
      const ledger = createEvidenceLedger({ sessionId, feature, tasks: [task] });
      writeEvidenceLedger(
        { projectDir, sessionId },
        {
          ...ledger,
          tasks: ledger.tasks.map((entry) => ({
            ...entry,
            promotedBriefHash: hashTaskBrief([task]),
            promotedFiles: [
              {
                path: 'src/shared.ts',
                sha256: sha256Hex('promoted by the killed run'),
                mode: 0o644,
              },
            ],
          })),
        },
      );

      const { init } = await initializeTestWorkflow({
        projectDir,
        sessionId,
        feature,
        savedState: {
          ...createInitialState(feature),
          phase: 'validating-task',
          tasks: [task],
          currentTaskIndex: 0,
          changedFilesBaseline: {
            head: null,
            fingerprints: {},
            activeTaskSnapshot: {
              head: 'HEAD',
              files: ['src/two.ts', 'src/shared.ts'],
              dirtyFileContents: { 'src/two.ts': 'original', 'src/shared.ts': 'original' },
            },
          },
        },
      });

      expect(init.ok).toBe(true);
      expect(readFileSync(join(projectDir, 'src/two.ts'), 'utf-8')).toBe('original');
      expect(readFileSync(join(projectDir, 'src/shared.ts'), 'utf-8')).toBe('original');
    });
  });
});

describe('initializeWorkflow — a brief killed while its runner was building', () => {
  it('restarts the brief and restores its files, the same as a kill mid-gate', async () => {
    await withTempDir('splitbrief-init-killed-implementing', async (projectDir) => {
      createTestGitRepo(projectDir, { 'src/two.ts': 'original' });
      writeFileSync(join(projectDir, 'src/two.ts'), 'half written by the killed run');
      const feature = 'resume a brief killed during the subprocess';
      const sessionId = 'session-init-killed-implementing';

      const { init, tracked } = await initializeTestWorkflow({
        projectDir,
        sessionId,
        feature,
        savedState: {
          ...createInitialState(feature),
          phase: 'implementing',
          tasks: [makeTask({ id: 'T001', status: 'in_progress', suggestedFiles: ['src/two.ts'] })],
          currentTaskIndex: 0,
          attempt: 1,
          changedFilesBaseline: {
            head: null,
            fingerprints: {},
            activeTaskSnapshot: {
              head: 'HEAD',
              files: ['src/two.ts'],
              dirtyFileContents: { 'src/two.ts': 'original' },
            },
          },
        },
      });

      expect(init.ok).toBe(true);
      expect(tracked.current).toMatchObject({
        phase: 'implementing',
        attempt: 0,
        tasks: [{ id: 'T001', status: 'pending' }],
      });
      expect(readFileSync(join(projectDir, 'src/two.ts'), 'utf-8')).toBe('original');
    });
  });

  it('keeps the partial edits of a brief the operator parked on purpose', async () => {
    await withTempDir('splitbrief-init-parked-brief', async (projectDir) => {
      createTestGitRepo(projectDir, { 'src/two.ts': 'original' });
      writeFileSync(join(projectDir, 'src/two.ts'), 'half written before the park');
      const feature = 'continue a parked brief';
      const sessionId = 'session-init-parked-brief';

      const { init, tracked } = await initializeTestWorkflow({
        projectDir,
        sessionId,
        feature,
        savedState: {
          ...createInitialState(feature),
          phase: 'implementing',
          tasks: [makeTask({ id: 'T001', status: 'in_progress', suggestedFiles: ['src/two.ts'] })],
          currentTaskIndex: 0,
          attempt: 1,
          interruptedStep: {
            step: { kind: 'brief', taskId: taskId('T001'), attempt: 1 },
            source: 'user',
            cut: 'mid-step',
            at: '2026-01-01T00:00:00.000Z',
          },
          changedFilesBaseline: {
            head: null,
            fingerprints: {},
            activeTaskSnapshot: {
              head: 'HEAD',
              files: ['src/two.ts'],
              dirtyFileContents: { 'src/two.ts': 'original' },
            },
          },
        },
      });

      expect(init.ok).toBe(true);
      expect(readFileSync(join(projectDir, 'src/two.ts'), 'utf-8')).toBe(
        'half written before the park',
      );
      expect(tracked.current).toMatchObject({ tasks: [{ id: 'T001', status: 'in_progress' }] });
    });
  });
});

describe('initializeWorkflow — a cut step that names a passed brief', () => {
  it('continues the brief that ran, not the passed one the stale index named', async () => {
    await withTempDir('splitbrief-init-stale-cut', async (projectDir) => {
      createTestGitRepo(projectDir, { 'src/passed.ts': 'passed', 'src/running.ts': 'original' });
      writeFileSync(join(projectDir, 'src/running.ts'), 'half written before the stop');
      const feature = 'continue after a skipped brief';
      const sessionId = 'session-init-stale-cut';
      const events: EngineEvent[] = [];

      const { init, tracked } = await initializeTestWorkflow({
        projectDir,
        sessionId,
        feature,
        eventSink: (event) => events.push(event),
        savedState: {
          ...createInitialState(feature),
          phase: 'escalating',
          tasks: [
            makeTask({ id: 'T001', status: 'done', suggestedFiles: ['src/reopened.ts'] }),
            makeTask({ id: 'T002', status: 'done', suggestedFiles: ['src/passed.ts'] }),
            makeTask({ id: 'T003', status: 'in_progress', suggestedFiles: ['src/running.ts'] }),
          ],
          currentTaskIndex: 1,
          attempt: 1,
          awaitingContinue: true,
          interruptedStep: {
            step: { kind: 'brief', taskId: taskId('T002'), attempt: 1 },
            source: 'user',
            cut: 'mid-step',
            at: '2026-01-01T00:00:00.000Z',
          },
          changedFilesBaseline: {
            head: null,
            fingerprints: {},
            activeTaskSnapshot: {
              head: 'HEAD',
              files: ['src/running.ts'],
              dirtyFileContents: { 'src/running.ts': 'original' },
            },
          },
        },
      });

      expect(init.ok).toBe(true);
      expect(tracked.current).toMatchObject({
        // The realigned cut names T003, and a mid-step brief cut is a park: the run continues
        // T003 with the partial it left instead of resetting it to the brief's start.
        phase: 'escalating',
        currentTaskIndex: 2,
        tasks: [
          { id: 'T001', status: 'done' },
          { id: 'T002', status: 'done' },
          { id: 'T003', status: 'in_progress' },
        ],
        interruptedStep: { step: { kind: 'brief', taskId: 'T003', attempt: 1 } },
      });
      expect(readFileSync(join(projectDir, 'src/running.ts'), 'utf-8')).toBe(
        'half written before the stop',
      );
      expect(
        events
          .filter((e): e is Extract<EngineEvent, { type: 'warning' }> => e.type === 'warning')
          .map((e) => e.message),
      ).toContain('The saved run pointed at T002, which already passed; continuing at T003.');
    });
  });
});

describe('initializeWorkflow — seat record', () => {
  it('builds the replacement PLAN seat without the primary native session and rebuilds its context', async () => {
    await withTempDir('splitbrief-init-recorded-plan-switch', async (projectDir) => {
      const ref = { projectDir, sessionId: 'recorded-plan-switch' };
      const feature = 'continue planning on the replacement';
      const config = makeConfig({
        planner: { kind: 'cli', tool: 'codex', model: 'gpt-6.1-sol' },
        reviewer: { kind: 'cli', tool: 'codex', model: 'gpt-6.1-sol' },
      });
      ensureSessionDir(projectDir, ref.sessionId);
      writeConfig(projectDir, config);
      writeSeatIdentities(ref, seatIdentitiesFromConfig(config));
      const candidate = { tool: 'claude-code', model: 'sonnet' };
      const state = {
        ...createInitialState(feature),
        phase: 'planning' as const,
        plannerSessionId: 'native-session-from-primary',
        pendingRecovery: makeRecoveryIssue({
          phase: 'planning',
          taskId: undefined,
          reason: 'runner-usage-limit',
          availableActions: ['switch-seat'],
          recommendedAction: 'switch-seat',
          switchSeat: { seat: 'plan', candidates: [candidate] },
        }),
      };
      saveState(ref, state);
      appendMessage(ref, { role: 'user', phase: state.phase, text: feature });
      const events: EngineEvent[] = [];
      const switched = await switchSeatAndPrepareResume({
        ...ref,
        config,
        state,
        candidate,
        bus: createRecoveryBus(ref),
        signal: new AbortController().signal,
        policy: {
          purpose: 'resume',
          interaction: 'headless',
          allowRepoRunners: false,
          allowHooks: false,
          unverifiedAuth: 'denied',
        },
        prepare: async (input) => ({
          kind: 'prepared',
          execution: makePreparedExecution({
            ...ref,
            feature,
            config: input.effectiveConfig,
            purpose: 'resume',
          }),
        }),
      });
      if (switched.kind !== 'switched') throw new Error('Expected PLAN switch');
      const planner = makePlanner();
      planner.capabilities.supportsSessionResume = true;
      const resumeHolder: ResumeContextHolder = { messages: [] };
      const { init } = await initializeTestWorkflow({
        ...ref,
        feature,
        savedState: switched.state,
        configOverrides: { planner: switched.config.planner },
        reviewer: switched.config.reviewer,
        plannerRunner: planner,
        resumeHolder,
        eventSink: (event) => events.push(event),
      });
      if (!init.ok) throw new Error('Expected resume init');
      expect(init.state.plannerSessionId).toBeNull();
      expect(createPlannerSeat).toHaveBeenLastCalledWith(
        expect.objectContaining({ initialSessionId: null }),
      );
      expect(resumeHolder.messages).toContainEqual(
        expect.objectContaining({ role: 'user', content: feature }),
      );
      expect(readSeatIdentities(ref)).toEqual(seatIdentitiesFromConfig(switched.config));
      expect(
        events.filter((event) => event.type === 'warning' && /seat changed/.test(event.message)),
      ).toEqual([]);
    });
  });

  it.each([
    { name: 'a tool default', candidate: { tool: 'opencode' }, notice: false },
    {
      name: 'a collision in the model words',
      candidate: { tool: 'opencode', model: 'opencode-go/deepseek-v4.1-flash', variant: 'high' },
      notice: false,
    },
    { name: 'an unrecorded config edit', candidate: undefined, notice: true },
    {
      name: 'a switch on another seat',
      candidate: { tool: 'opencode' },
      seat: 'review',
      notice: true,
    },
    {
      name: 'another destination with the same model words and axis',
      candidate: { tool: 'opencode', model: 'deepseek/deepseek-flash', variant: 'high' },
      notice: true,
    },
    {
      name: 'a switch already resumed',
      candidate: { tool: 'opencode', model: 'opencode-go/deepseek-v4.1-flash', variant: 'high' },
      resumed: true,
      notice: true,
    },
  ] as const)('reconciles BUILD after $name', async (scenario) => {
    await withTempDir('splitbrief-init-switch-notice', async (projectDir) => {
      const ref = { projectDir, sessionId: 'switch-notice' };
      const feature = 'continue the brief';
      const config = makeConfig({
        implementer: { kind: 'cli', tool: 'opencode', model: 'deepseek/deepseek-flash' },
      });
      const replacement =
        scenario.candidate === undefined || scenario.notice
          ? { tool: 'opencode', model: 'opencode-go/deepseek-v4.1-flash', variant: 'high' }
          : scenario.candidate;
      const current = configWithSwitchedSeat(config, 'build', replacement);
      if (current === null) throw new Error('Expected switched config');
      ensureSessionDir(projectDir, ref.sessionId);
      writeConfig(projectDir, config);
      writeSeatIdentities(ref, seatIdentitiesFromConfig(config));
      const state = { ...createInitialState(feature), phase: 'implementing' as const };
      saveState(ref, state);
      const bus = createRecoveryBus(ref);
      if (scenario.candidate !== undefined) {
        bus.publish({
          type: 'seat_switched',
          ts: Date.now(),
          phase: state.phase,
          seat: 'seat' in scenario ? scenario.seat : 'build',
          from: { tool: 'opencode', model: 'deepseek/deepseek-flash' },
          to: scenario.candidate,
          cause: 'runner-usage-limit',
          auto: true,
          configRevision: 'recorded-revision',
        });
      }
      if ('resumed' in scenario) {
        bus.publish({ type: 'workflow_resumed', ts: Date.now(), phase: state.phase });
      }
      writeConfig(projectDir, current);
      const events: EngineEvent[] = [];
      const { init } = await initializeTestWorkflow({
        ...ref,
        feature,
        savedState: state,
        configOverrides: { implementer: loadConfig(projectDir).config.implementer },
        eventSink: (event) => events.push(event),
      });
      expect(init.ok).toBe(true);
      const changes = events.filter(
        (event) =>
          event.type === 'seat_switched' &&
          event.seat === 'build' &&
          event.cause === 'crew-changed',
      );
      expect(changes).toHaveLength(scenario.notice ? 1 : 0);
      expect(
        events.filter((event) => event.type === 'warning' && /seat changed/.test(event.message)),
      ).toEqual([]);
      expect(readSeatIdentities(ref)).toEqual(seatIdentitiesFromConfig(current));
    });
  });

  it('records the seats every run starts on, interactive included', async () => {
    await withTempDir('splitbrief-init-seats', async (projectDir) => {
      const sessionId = 'session-init-seats';

      const { init } = await initializeTestWorkflow({
        projectDir,
        sessionId,
        feature: 'record the seats',
      });

      expect(init.ok).toBe(true);
      const recorded = readSeatIdentities({ projectDir, sessionId });
      expect(recorded).not.toBeNull();
      const identities = [recorded?.plan, recorded?.build, recorded?.review];
      expect(identities.every((identity) => (identity ?? '').length > 0)).toBe(true);
    });
  });

  it('records the persisted seat kinds beside their tools and reads them back', async () => {
    await withTempDir('splitbrief-init-seat-kinds', async (projectDir) => {
      const sessionId = 'session-init-seat-kinds';

      const { init } = await initializeTestWorkflow({
        projectDir,
        sessionId,
        feature: 'record the seat kinds',
        plannerKind: 'cli',
        implementerKind: 'api',
      });

      expect(init.ok).toBe(true);
      const saved = loadState({ projectDir, sessionId });
      expect(saved?.plannerKind).toBe('cli');
      expect(saved?.implementerKind).toBe('api');
      expect(saved).not.toHaveProperty('reviewerKind');
    });
  });

  it('keeps a resumed legacy state without kinds instead of re-labelling its seats', async () => {
    await withTempDir('splitbrief-init-seat-kinds-legacy', async (projectDir) => {
      const feature = 'resume a legacy state';
      const sessionId = 'session-init-seat-kinds-legacy';

      const { init, tracked } = await initializeTestWorkflow({
        projectDir,
        sessionId,
        feature,
        plannerKind: 'cli',
        implementerKind: 'api',
        savedState: { ...createInitialState(feature), phase: 'implementing' },
      });

      expect(init.ok).toBe(true);
      expect(tracked.current).not.toHaveProperty('plannerKind');
      expect(tracked.current).not.toHaveProperty('implementerKind');
    });
  });

  it('names both sides of a moved seat in the words the seat identity uses', async () => {
    await withTempDir('splitbrief-init-seat-labels', async (projectDir) => {
      const feature = 'resume on another model';
      const sessionId = 'session-init-seat-labels';
      const events: EngineEvent[] = [];
      ensureSessionDir(projectDir, sessionId);
      writeSeatIdentities(
        { projectDir, sessionId },
        seatIdentitiesFromConfig(
          makeConfig({
            planner: { kind: 'cli', tool: 'claude-code', model: 'opus', effort: 'max' },
          }),
        ),
      );

      const { init } = await initializeTestWorkflow({
        projectDir,
        sessionId,
        feature,
        savedState: { ...createInitialState(feature), phase: 'implementing' },
        eventSink: (e) => events.push(e),
      });

      expect(init.ok).toBe(true);
      // With no review block the planner holds the review seat, so both seats moved.
      expect(events.filter((e) => e.type === 'seat_switched')).toEqual(
        (['plan', 'review'] as const).map((seat) =>
          expect.objectContaining({
            seat,
            from: 'Claude Code CLI · Opus 5.5 · max',
            to: 'Claude Code CLI · auto',
            cause: 'crew-changed',
            auto: false,
          }),
        ),
      );
      expect(events.filter((e) => e.type === 'warning' && /seat changed/.test(e.message))).toEqual(
        [],
      );
    });
  });

  it("keeps the plan seat's session when its record left out the level its id spells", async () => {
    await withTempDir('splitbrief-init-seat-id-level', async (projectDir) => {
      const feature = 'resume on the same crew';
      const ref = { projectDir, sessionId: 'session-init-seat-id-level' };
      const planner = { kind: 'cli', tool: 'antigravity', model: 'gemini-3.8-flash-high' } as const;
      const events: EngineEvent[] = [];
      ensureSessionDir(projectDir, ref.sessionId);
      // The record an older version wrote for this crew: the axes held the effort flag alone.
      const ids = { tool: 'antigravity', model: planner.model, axes: [], kind: 'cli' } as const;
      const identity = 'Google Antigravity CLI · Gemini 3.8 Flash (High)';
      writeSeatIdentities(ref, {
        plan: identity,
        build: identity,
        review: identity,
        ids: { plan: ids, build: ids, review: ids },
      });

      const { init, tracked } = await initializeTestWorkflow({
        ...ref,
        feature,
        configOverrides: { planner, implementer: planner },
        reviewer: planner,
        savedState: {
          ...createInitialState(feature),
          phase: 'implementing',
          plannerSessionId: 'session-minted-by-the-same-seat',
        },
        eventSink: (e) => events.push(e),
      });

      expect(init.ok).toBe(true);
      expect(
        events.filter((event) => event.type === 'warning' && /seat changed/.test(event.message)),
      ).toEqual([]);
      expect(tracked.current?.plannerSessionId).toBe('session-minted-by-the-same-seat');
      expect(readSeatIdentities(ref)?.plan).toBe(
        'Google Antigravity CLI · Gemini 3.8 Flash · high',
      );
    });
  });

  it("re-records the crew on resume and clears the moved plan seat's session", async () => {
    await withTempDir('splitbrief-init-seat-change', async (projectDir) => {
      const feature = 'resume on another crew';
      const sessionId = 'session-init-seat-change';
      const retired = 'Retired Tool · retired-model';
      const events: EngineEvent[] = [];
      ensureSessionDir(projectDir, sessionId);
      writeSeatIdentities(
        { projectDir, sessionId },
        { plan: retired, build: retired, review: retired },
      );

      const { init, tracked } = await initializeTestWorkflow({
        projectDir,
        sessionId,
        feature,
        savedState: {
          ...createInitialState(feature),
          phase: 'implementing',
          plannerSessionId: 'session-minted-by-the-retired-tool',
        },
        eventSink: (e) => events.push(e),
      });

      expect(init.ok).toBe(true);
      const changes = events.filter((e) => e.type === 'seat_switched');
      expect(changes).toEqual([
        expect.objectContaining({
          seat: 'plan',
          from: retired,
          cause: 'crew-changed',
          auto: false,
        }),
        expect.objectContaining({
          seat: 'build',
          from: retired,
          cause: 'crew-changed',
          auto: false,
        }),
        expect.objectContaining({
          seat: 'review',
          from: retired,
          cause: 'crew-changed',
          auto: false,
        }),
      ]);
      expect(events.filter((e) => e.type === 'warning' && /seat changed/.test(e.message))).toEqual(
        [],
      );
      expect(readSeatIdentities({ projectDir, sessionId })?.plan).not.toBe(retired);
      expect(tracked.current?.plannerSessionId).toBeNull();
    });
  });
});

describe('initializeWorkflow — the @ context outlives the process', () => {
  const CONTEXT = '# tasks.md\n- T001 wire the banner';

  it('persists the context at start and hands it back on a continue that has none', async () => {
    await withTempDir('splitbrief-init-planner-context', async (projectDir) => {
      const feature = 'ship the banner';
      const sessionId = 'session-init-planner-context';

      const started = await initializeTestWorkflow({
        projectDir,
        sessionId,
        feature,
        plannerContext: CONTEXT,
      });

      expect(started.init.ok).toBe(true);
      if (!started.init.ok) return;
      expect(started.init.wctx.plannerContext).toBe(CONTEXT);
      const saved = loadState({ projectDir, sessionId });
      expect(saved?.plannerContext).toBe(CONTEXT);
      if (!saved) return;

      const continued = await initializeTestWorkflow({
        projectDir,
        sessionId,
        feature,
        savedState: saved,
      });

      expect(continued.init.ok).toBe(true);
      if (!continued.init.ok) return;
      expect(continued.init.wctx.plannerContext).toBe(CONTEXT);
    });
  });
});

describe('initializeWorkflow — the mode a run starts in', () => {
  it.each([
    ['quick', 'planning'],
    ['standard', 'planning'],
    ['speckit', 'planning'],
  ] as const)('saves the %s setup in %s, the one planning session', async (mode, phase) => {
    await withTempDir('splitbrief-init-first-phase', async (projectDir) => {
      const sessionId = `session-init-${mode}-phase`;
      const events: EngineEvent[] = [];
      const { init } = await initializeTestWorkflow({
        projectDir,
        sessionId,
        feature: 'ship the banner',
        configOverrides: { workflow: { mode } },
        eventSink: (event) => events.push(event),
      });

      expect(init.ok).toBe(true);
      expect(loadState({ projectDir, sessionId })?.phase).toBe(phase);
      expect(events).toContainEqual(expect.objectContaining({ type: 'workflow_started', phase }));
      expect(events).toContainEqual(expect.objectContaining({ type: 'planner_status', phase }));
    });
  });

  it('saves the approval level it resolves with the start, and no workflow mode', async () => {
    await withTempDir('splitbrief-init-mode', async (projectDir) => {
      const sessionId = 'session-init-mode';
      const started = await initializeTestWorkflow({
        projectDir,
        sessionId,
        feature: 'ship the banner',
        configOverrides: { workflow: { approve: 'plan' } },
      });

      expect(started.init.ok).toBe(true);
      const saved = loadState({ projectDir, sessionId });
      expect(saved).toMatchObject({ approve: 'plan' });
      expect(saved).not.toHaveProperty('mode');
    });
  });
});

describe('initializeWorkflow — a file halt saved before the run workspace', () => {
  /** The brief is in flight with its output on record, so the halt read as standing before S7. */
  function recordBriefOutput(projectDir: string, sessionId: string, task: Task): void {
    ensureSessionDir(projectDir, sessionId);
    const ledger = createEvidenceLedger({ sessionId, feature: 'feat', tasks: [task] });
    writeEvidenceLedger(
      { projectDir, sessionId },
      {
        ...ledger,
        tasks: ledger.tasks.map((entry) => ({
          ...entry,
          promotedBriefHash: hashTaskBrief([task]),
          promotedFiles: [{ path: 'src/edited.ts', sha256: sha256Hex('original'), mode: 0o644 }],
        })),
      },
    );
  }

  async function initWithHalt(
    projectDir: string,
    sessionId: string,
    feature: string,
    halt: Partial<RecoveryIssue>,
    run: Partial<WorkflowState> = {},
  ) {
    const baseline = serializeChangedFilesBaseline(await captureChangedFilesBaseline(projectDir));
    const task = makeTask({ id: 'T001', status: 'in_progress', suggestedFiles: ['src/edited.ts'] });
    recordBriefOutput(projectDir, sessionId, task);
    writeFileSync(join(projectDir, 'src/edited.ts'), 'still edited');
    const events: EngineEvent[] = [];
    const result = await initializeTestWorkflow({
      projectDir,
      sessionId,
      feature,
      eventSink: (event) => events.push(event),
      savedState: {
        ...createInitialState(feature),
        phase: 'implementing',
        tasks: [task],
        currentTaskIndex: 0,
        changedFilesBaseline: baseline,
        ...run,
        pendingRecovery: makeRecoveryIssue({
          phase: 'implementing',
          taskId: taskId('T001'),
          files: ['src/edited.ts'],
          availableActions: ['retry-same-worker', 'end-run'],
          recommendedAction: 'retry-same-worker',
          ...halt,
        }),
      },
    });
    return { ...result, events };
  }

  it.each([
    { name: 'user-edit conflict', halt: { reason: 'user-edit-conflict' } },
    { name: 'constitution check', halt: { reason: 'constitution-check-failed' } },
    { name: 'scope violation', halt: { reason: 'scope-violation' } },
    {
      name: 'partial approval promotion conflict',
      halt: { reason: 'approval-promotion-conflict', facts: { partialPromotion: true } },
    },
    {
      name: 'checkout HEAD and current-branch move',
      halt: {
        reason: 'checkout-changed',
        message: 'Your checkout changed under T001 — HEAD · branch main',
        details: ['Changed while Codex ran: HEAD · branch main'],
      },
    },
  ] satisfies { name: string; halt: Partial<RecoveryIssue> }[])(
    'an old pending $name halt resolves on continue with a notice',
    async ({ halt }) => {
      await withTempDir('splitbrief-init-old-halt', async (projectDir) => {
        createTestGitRepo(projectDir, { 'src/edited.ts': 'original' });
        const sessionId = 'session-init-old-halt';

        const { init, tracked, events } = await initWithHalt(
          projectDir,
          sessionId,
          'continue past a halt the run workspace retired',
          halt,
        );

        expect(init.ok).toBe(true);
        expect(tracked.current?.pendingRecovery).toBeUndefined();
        expect(loadState({ projectDir, sessionId })?.pendingRecovery).toBeUndefined();
        expect(events.find((event) => event.type === 'recovery_resolved')).toMatchObject({
          action: 'continue',
          outcome: 'continued',
        });
        expect(
          events
            .filter((event): event is Extract<EngineEvent, { type: 'warning' }> => {
              return event.type === 'warning';
            })
            .map((event) => event.message),
        ).toContain('The halt this run saved no longer applies; continuing.');
      });
    },
  );

  it('keeps a branch-only checkout-changed halt raised in a run that has its own workspace', async () => {
    await withTempDir('splitbrief-init-workspace-halt', async (projectDir) => {
      createTestGitRepo(projectDir, { 'src/edited.ts': 'original' });
      const sessionId = 'session-init-workspace-halt';

      const { init, tracked, events } = await initWithHalt(
        projectDir,
        sessionId,
        'keep a halt about a branch the implementer created',
        {
          reason: 'checkout-changed',
          message: 'Your checkout changed under T001 — branch topic',
        },
        {
          workspace: {
            kind: 'worktree',
            path: join(projectDir, '.splitbrief', 'worktrees', 'run'),
            base: { snapshotId: 'base', head: null },
          },
        },
      );

      expect(init.ok).toBe(true);
      expect(tracked.current?.pendingRecovery).toMatchObject({ reason: 'checkout-changed' });
      expect(events.find((event) => event.type === 'recovery_resolved')).toBeUndefined();
    });
  });

  it.each([
    'Your checkout changed under T001 — HEAD · stash',
    'Your checkout changed under T001 — branch main · hook pre-commit',
    'Your checkout changed under T001 — HEAD · branch main · branch topic · 1 more',
  ])(
    'keeps a checkout-changed halt that names more than a HEAD or branch move: %s',
    async (message) => {
      await withTempDir('splitbrief-init-standing-halt', async (projectDir) => {
        createTestGitRepo(projectDir, { 'src/edited.ts': 'original' });
        const sessionId = 'session-init-standing-halt';

        const { init, tracked, events } = await initWithHalt(
          projectDir,
          sessionId,
          'keep a halt about a git write Apply does not merge',
          { reason: 'checkout-changed', message },
        );

        expect(init.ok).toBe(true);
        expect(tracked.current?.pendingRecovery).toMatchObject({ reason: 'checkout-changed' });
        expect(events.find((event) => event.type === 'recovery_resolved')).toBeUndefined();
      });
    },
  );
});
