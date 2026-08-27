import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTrustHome } from '#testing/helpers/trust-home.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import {
  makeCallbacks,
  makeImplementer,
  makePlanner,
} from '#testing/helpers/orchestrator-factories.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeRunnerGate } from '#testing/helpers/runner-gate.js';
import type { Config } from '../../../core/schemas/config.js';
import type { ReadinessReport } from '../../../core/readiness/types.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { EngineEvent } from '../../events/types.js';
import { ensureSessionDir, readSpecFile } from '../../../core/paths-io.js';
import { TASKS_FILE } from '../../../core/paths.js';
import { createInitialState, transition } from '../../../core/state/machine.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { saveState } from '../../../core/state/persistence.js';
import { reactivateExistingSession } from '../../../core/sessions/active-pointer.js';
import { generateSessionId } from '../../../core/sessions/session-id.js';
import { parsePreparedConfig, type RunnerGate } from '../../runners/prepared-execution.js';
import { resolveImplementerProfiles } from '../../../core/config/accessors/implementer-profiles.js';
import { resolveHooksConfig } from '../../hooks/discover.js';
import { runWorkflow as runPreparedWorkflow } from './workflow.js';
import type { RunWorkflowOptions } from './init.js';
import { createBriefRecoveryState } from '../planning/brief-recovery.js';
import { persistReadyExecutionState } from '#testing/helpers/persisted-execution.js';
import { formatTasks } from '../../spec/formatter.js';
import { sha256Hex } from '../../../utils/sha256.js';

let dirs: string[] = [];
let trustHome: ReturnType<typeof useTrustHome>;

beforeEach(() => {
  trustHome = useTrustHome('run-workflow-permit-trust-home');
});

afterEach(() => {
  for (const dir of dirs) cleanupTempDir(dir);
  dirs = [];
  trustHome.restore();
});

function readyReport(projectDir: string): ReadinessReport {
  return {
    generatedAt: new Date(0).toISOString(),
    projectDir,
    status: 'ready',
    counts: { ok: 1, info: 0, warning: 0, blocker: 0 },
    nextAction: { kind: 'continue', label: 'Continue', reason: 'ready' },
    sections: [],
    metadata: {},
  };
}

function setupProject(): string {
  const projectDir = createTempDir('run-workflow-permit-test');
  dirs.push(projectDir);
  createTestGitRepo(projectDir);
  return projectDir;
}

type WorkflowTestOptions = Omit<RunWorkflowOptions, 'prepared'> & {
  feature: string;
  projectDir: string;
  config: Config;
  sessionId?: string | undefined;
  savedState?: WorkflowState | undefined;
};

async function runWorkflow(input: WorkflowTestOptions) {
  const {
    feature,
    projectDir,
    config: inputConfig,
    sessionId: explicitSessionId,
    ...options
  } = input;
  const hooks = await resolveHooksConfig(projectDir, inputConfig.hooks);
  const config = parsePreparedConfig(hooks === undefined ? inputConfig : { ...inputConfig, hooks });
  const sessionId =
    explicitSessionId ??
    generateSessionId({
      projectDir,
      feature,
      persistTranscript: config.workflow.persistTranscript,
    });
  ensureSessionDir(projectDir, sessionId);
  const active = reactivateExistingSession({ projectDir, sessionId });
  const preparationId = `workflow-permit-test-${sessionId}`;
  const gates: RunnerGate[] = [
    makeRunnerGate(config.planner, { role: 'planner' }, preparationId),
    ...resolveImplementerProfiles(config).profiles.map((profile) =>
      makeRunnerGate(profile.config, { role: 'implementer', profile: profile.name }, preparationId),
    ),
  ];
  const purpose = input.savedState === undefined ? 'new-workflow' : 'resume';
  return runPreparedWorkflow({
    ...options,
    prepared: {
      purpose,
      config,
      preparationId,
      report: readyReport(projectDir),
      gates,
      session: { kind: 'existing', ref: { projectDir, sessionId }, active },
      runtime: {
        feature,
        ...(input.savedState === undefined ? {} : { resumeState: input.savedState }),
        allowRepoRunners: false,
        allowHooks: true,
      },
    },
  });
}

function quickConfig(): Config {
  return makeConfig({
    validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
    workflow: {
      approve: 'none',
      mode: 'quick',
      persistTranscript: false,
    },
  });
}

function makePassingTaskFixture(id: string) {
  return makeTask({
    id,
    scope: { inBounds: ['src/hello.ts'], outOfBounds: ['other files'] },
    evidence: ['task_completed event shows the task ran'],
    typeDefs: 'type HelloTask = { file: string }',
  });
}

describe('runWorkflow — disposition and persisted permit switch', () => {
  it('calls the implementer only for ready-for-tasks with a matching persisted permit', async () => {
    const projectDir = setupProject();
    const sessionId = 'sess-permit-ready';
    const task = makePassingTaskFixture('T001');
    const persisted = persistReadyExecutionState(
      { projectDir, sessionId },
      makeImplState([task], { stateFence: { token: 1, ownerId: 'permit-test-owner' } }),
    );
    const implement = vi.fn().mockResolvedValue({
      success: true,
      output: 'code',
      usage: { inputTokens: 50, outputTokens: 25 },
    });
    const { callbacks } = makeCallbacks();
    const events: EngineEvent[] = [];

    const summary = await runWorkflow({
      feature: 'ready with permit',
      projectDir,
      config: quickConfig(),
      sessionId,
      savedState: persisted,
      callbacks,
      sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
      _eventSink: (e) => events.push(e),
      _planner: makePlanner(),
      _implementer: makeImplementer({ implement }),
    });

    expect(implement).toHaveBeenCalledTimes(1);
    expect(events.filter((e) => e.type === 'task_started')).toHaveLength(1);
    expect(summary.totalTasks).toBe(1);
  }, 30_000);

  it('parks a reviewing-briefs resume without an implementer call or approval warning', async () => {
    const projectDir = setupProject();
    const sessionId = 'sess-permit-parked';
    const parked: WorkflowState = {
      ...createInitialState('parked resume'),
      phase: 'reviewing-briefs',
      stateFence: { token: 1, ownerId: 'permit-test-owner' },
    };
    saveState({ projectDir, sessionId }, parked);
    const implement = vi.fn().mockResolvedValue({
      success: true,
      output: 'code',
      usage: { inputTokens: 50, outputTokens: 25 },
    });
    const { callbacks } = makeCallbacks();
    const events: EngineEvent[] = [];

    await runWorkflow({
      feature: 'parked resume',
      projectDir,
      config: quickConfig(),
      sessionId,
      savedState: parked,
      callbacks,
      sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
      _eventSink: (e) => events.push(e),
      _planner: makePlanner(),
      _implementer: makeImplementer({ implement }),
    });

    expect(implement).not.toHaveBeenCalled();
    expect(events.filter((e) => e.type === 'task_started')).toHaveLength(0);
    expect(
      events.some((e) => e.type === 'warning' && e.code === 'approval_prompt_not_restored'),
    ).toBe(false);
  }, 30_000);

  it('treats a rejected terminal state as final without an implementer call', async () => {
    const projectDir = setupProject();
    const sessionId = 'sess-permit-terminal';
    const admission = {
      sessionId,
      origin: { mode: 'quick' as const, entry: 'initial' as const },
      continuation: {
        version: 1 as const,
        kind: 'quick-start' as const,
        entry: 'initial' as const,
      },
      activeBrief: { revision: 1, hash: 'b'.repeat(64), path: 'tasks.md' },
      report: {
        briefHash: 'b'.repeat(64),
        report: { revision: 1, hash: 'r'.repeat(64), path: 'brief-quality.json' },
        ruleVersion: 'brief-quality-v1',
        issues: [],
        errorCount: 0,
      },
      qualityPolicyVersion: 'brief-quality-v1',
    };
    let state = transition(createInitialState('rejected terminal'), { type: 'START' });
    state = transition(state, {
      type: 'BRIEF_ADMISSION_OPENED',
      briefRecovery: createBriefRecoveryState(admission, { epochId: 'epoch-rejected' }),
    });
    state = transition(state, { type: 'REJECT_BRIEFS' });
    expect(state.phase).toBe('idle');
    expect(state.briefRecovery?.status).toBe('rejected');
    saveState({ projectDir, sessionId }, state);
    const implement = vi.fn().mockResolvedValue({
      success: true,
      output: 'code',
      usage: { inputTokens: 50, outputTokens: 25 },
    });
    const { callbacks } = makeCallbacks();
    const events: EngineEvent[] = [];

    await runWorkflow({
      feature: 'rejected terminal',
      projectDir,
      config: quickConfig(),
      sessionId,
      savedState: state,
      callbacks,
      sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
      _eventSink: (e) => events.push(e),
      _planner: makePlanner(),
      _implementer: makeImplementer({ implement }),
    });

    expect(implement).not.toHaveBeenCalled();
    expect(events.filter((e) => e.type === 'task_started')).toHaveLength(0);
  }, 30_000);

  it('parks an implementing resume whose persisted permit is missing', async () => {
    const projectDir = setupProject();
    const sessionId = 'sess-permit-stale';
    const task = makePassingTaskFixture('T001');
    const implementing = makeImplState([task], {
      stateFence: { token: 1, ownerId: 'permit-test-owner' },
    });
    const stale: WorkflowState = {
      ...implementing,
      generation: null,
      permit: null,
      authorityRevision: undefined,
    };
    saveState({ projectDir, sessionId }, stale);
    const implement = vi.fn().mockResolvedValue({
      success: true,
      output: 'code',
      usage: { inputTokens: 50, outputTokens: 25 },
    });
    const { callbacks } = makeCallbacks();
    const events: EngineEvent[] = [];

    await runWorkflow({
      feature: 'stale permit',
      projectDir,
      config: quickConfig(),
      sessionId,
      savedState: stale,
      callbacks,
      sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
      _eventSink: (e) => events.push(e),
      _planner: makePlanner(),
      _implementer: makeImplementer({ implement }),
    });

    expect(implement).not.toHaveBeenCalled();
    expect(events.filter((e) => e.type === 'task_started')).toHaveLength(0);
    expect(
      events.some((e) => e.type === 'warning' && e.code === 'approval_prompt_not_restored'),
    ).toBe(false);
  }, 30_000);
});

describe('runWorkflow — approved brief byte binding', () => {
  it('keeps the approved tasks.md byte-stable across the permit settlement', async () => {
    const projectDir = setupProject();
    const sessionId = 'sess-permit-bytes';
    const task = makePassingTaskFixture('T001');
    const text = formatTasks([task]);
    const persisted = persistReadyExecutionState(
      { projectDir, sessionId },
      makeImplState([task], { stateFence: { token: 1, ownerId: 'permit-test-owner' } }),
    );
    const approvedHash = persisted.briefRecovery?.activeBrief?.hash;
    const implement = vi.fn().mockResolvedValue({
      success: true,
      output: 'code',
      usage: { inputTokens: 50, outputTokens: 25 },
    });
    const { callbacks } = makeCallbacks();

    await runWorkflow({
      feature: 'approved brief bytes',
      projectDir,
      config: quickConfig(),
      sessionId,
      savedState: persisted,
      callbacks,
      sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
      _planner: makePlanner(),
      _implementer: makeImplementer({ implement }),
    });

    expect(implement).toHaveBeenCalledTimes(1);
    const onDisk = readSpecFile({ projectDir, sessionId }, TASKS_FILE);
    expect(onDisk).not.toBeNull();
    expect(sha256Hex(onDisk ?? '')).toBe(sha256Hex(text));
    expect(sha256Hex(onDisk ?? '')).toBe(approvedHash);
  }, 30_000);
});
