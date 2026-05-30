import { describe, it, expect, vi, afterEach } from 'vitest';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkflowState } from '../../core/schemas/workflow.js';
import { createInitialState, transition } from '../../core/state/machine.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import {
  makeCallbacks,
  makePlanner,
  makeBusRecorder,
} from '#testing/helpers/orchestrator-factories.js';
import { expectBriefQualityBlocked } from '#testing/helpers/assertions/brief-quality.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { ensureSessionDir } from '../../core/paths-io.js';
import { BRIEF_QUALITY_FILE, sessionDir, TASKS_FILE } from '../../core/paths.js';
import { runPlanningPhase } from './planning/run.js';
import { createEvidenceLedger, writeEvidenceLedger } from '../../core/evidence/ledger.js';
import { recordRejectionEvidence } from './evidence/approval-evidence.js';
import type { OrchestratorCallbacks, WorkflowSinks } from './types.js';
import type { Planner } from '../planners/types.js';
import type { Config } from '../../core/schemas/config.js';

const TEST_METADATA = {
  plannerTool: 'claude-code',
  implementerTool: 'ollama',
  mode: 'standard',
} as const;

const REAL_TASKS_MD = `---
id: T001
title: Add auth
action: create
file: src/auth.ts
---

### Description

Add JWT-based authentication.

### Tests

- passes tsc

### Implementation Steps

1. Implement the authentication module.

### Scope

**In bounds:**
- authentication plumbing in src/auth.ts
**Out of bounds:**
- unrelated UI or persistence changes

### Escalation

- Stop if existing auth behavior is ambiguous.

### Evidence

- brief-quality.json records a passing gate
`;

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) cleanupTempDir(d);
  dirs = [];
});

function setupProject(): { projectDir: string; sessionId: string } {
  const projectDir = createTempDir('planning-test');
  dirs.push(projectDir);
  const sessionId = 'sess-planning';
  ensureSessionDir(projectDir, sessionId);
  return { projectDir, sessionId };
}

function createTestSinks(): WorkflowSinks & { abortTurn: () => boolean } {
  let abortHandler: (() => void) | null = null;
  return {
    setAbortHandler: (h) => {
      abortHandler = h;
    },
    setQueueHandler: () => {},
    abortTurn: () => {
      if (!abortHandler) return false;
      abortHandler();
      return true;
    },
  };
}

function prepareState(
  phase?: 'specifying' | 'planning',
  rewindPending?: WorkflowState['rewindPending'],
): WorkflowState {
  const initial = createInitialState('test-feature');
  if (phase) return { ...initial, phase, rewindPending };
  return transition(initial, { type: 'START', feature: 'test-feature' });
}

function makePassingTask(id = 'T001') {
  return makeTask({
    id,
    scope: { inBounds: ['auth flow'], outOfBounds: ['unrelated UI'] },
    evidence: ['brief-quality.json confirms the task brief is complete'],
    typeDefs: 'type AuthTask = { userId: string }',
  });
}

function makeBriefQualityFailureTask() {
  return makeTask({
    scope: undefined,
    evidence: [],
  });
}

function makePassingPlanner(overrides?: Partial<Planner>): Planner {
  return makePlanner({
    plan: vi.fn().mockResolvedValue({
      spec: '# Spec',
      plan: '# Plan',
      tasks: [makePassingTask()],
      usage: { inputTokens: 100, outputTokens: 50 },
    }),
    quickPlan: vi.fn().mockResolvedValue({
      spec: '',
      plan: '',
      tasks: [makePassingTask()],
      usage: { inputTokens: 50, outputTokens: 25 },
    }),
    ...overrides,
  });
}

function seedRejectionEvidence(projectDir: string, sessionId: string): void {
  let ledger = createEvidenceLedger({
    sessionId,
    feature: 'previous feature',
    mode: 'standard',
    tasks: [makePassingTask()],
  });
  ledger = recordRejectionEvidence({
    ledger,
    tier: 'sticky',
    actionClass: 'network',
    actionDescription: 'fetch https://api.example.com/audit',
    reason: 'user denied network access',
  });
  writeEvidenceLedger(projectDir, sessionId, ledger);
}

function sequencedApproval(
  responses: Array<{ approved: boolean; comment?: string; action?: 'edit' }>,
): OrchestratorCallbacks['onApprovalNeeded'] {
  const fn = vi.fn<OrchestratorCallbacks['onApprovalNeeded']>();
  for (const r of responses) fn.mockResolvedValueOnce(r);
  return fn;
}

const auto = (mode?: Config['workflow']['mode']): Partial<Config['workflow']> => ({
  autoApproveSpec: true,
  autoApprovePlan: true,
  ...(mode ? { mode } : {}),
});
const manual = (mode?: Config['workflow']['mode']): Partial<Config['workflow']> => ({
  autoApproveSpec: false,
  autoApprovePlan: false,
  ...(mode ? { mode } : {}),
});

type RunOpts = {
  planner?: Planner;
  callbacks?: OrchestratorCallbacks;
  config?: Config;
  state?: WorkflowState;
  rewindPending?: WorkflowState['rewindPending'];
  sinks?: WorkflowSinks & { abortTurn: () => boolean };
};

async function runPhase(opts: RunOpts = {}) {
  const { projectDir, sessionId } = setupProject();
  const planner = opts.planner ?? makePassingPlanner();
  const callbacks = opts.callbacks ?? makeCallbacks().callbacks;
  const config = opts.config ?? makeConfig();
  const state = opts.state ?? prepareState();
  const sinks = opts.sinks ?? createTestSinks();
  const recorder = makeBusRecorder();
  const result = await runPlanningPhase({
    wctx: {
      projectDir,
      config,
      callbacks,
      metadata: TEST_METADATA,
      sessionId,
      sinks,
      bus: recorder.bus,
    },
    planner,
    state,
    feature: 'test-feature',
    ...(opts.rewindPending ? { rewindPending: opts.rewindPending } : {}),
  });
  return { result, projectDir, sessionId, events: recorder.events };
}

describe('runPlanningPhase — happy paths (modes + approval)', () => {
  const happyCases: Array<{
    name: string;
    workflow: Partial<Config['workflow']>;
    approvals?: Array<{ approved: boolean }>;
    useQuickPlan?: boolean;
  }> = [
    { name: 'manual approval (default mode)', workflow: manual() },
    { name: 'auto-approve both completes without user interaction', workflow: auto() },
    {
      name: 'quick mode skips approval and uses quickPlan',
      workflow: manual('quick'),
      useQuickPlan: true,
    },
    {
      name: 'standard mode uses spec + briefs approval gates',
      workflow: manual('standard'),
      approvals: [{ approved: true }, { approved: true }],
    },
    {
      name: 'speckit mode requires spec + plan + briefs approvals',
      workflow: manual('speckit'),
      approvals: [{ approved: true }, { approved: true }, { approved: true }],
    },
  ];

  it.each(happyCases)('$name', async ({ workflow, approvals, useQuickPlan }) => {
    const onApprovalNeeded = approvals ? sequencedApproval(approvals) : undefined;
    const { callbacks } = makeCallbacks(onApprovalNeeded ? { onApprovalNeeded } : undefined);
    // Distinctive task id lets us verify quickPlan's output flowed through, not plan's.
    let quickPlanCalls = 0;
    const quickPlan = useQuickPlan
      ? async () => {
          quickPlanCalls++;
          return {
            spec: '',
            plan: '',
            tasks: [makePassingTask('T-QUICK')],
            usage: { inputTokens: 50, outputTokens: 25 },
          };
        }
      : undefined;
    const planner = makePassingPlanner(quickPlan ? { quickPlan } : undefined);

    const { result } = await runPhase({ planner, callbacks, config: makeConfig({ workflow }) });

    expect(result.cancelled).toBe(false);
    expect(result.tasks).toHaveLength(1);
    expect(result.state.phase).toBe('implementing');
    if (useQuickPlan) {
      expect(quickPlanCalls).toBe(1);
      expect(result.tasks[0]?.id).toBe('T-QUICK');
    }
  });

  it('user comment → spec regenerated, workflow completes', async () => {
    const onApprovalNeeded = sequencedApproval([
      { approved: false, comment: 'add auth section' },
      { approved: true },
      { approved: true },
    ]);
    const { callbacks } = makeCallbacks({ onApprovalNeeded });
    // After regeneration, regeneratePlanAndTasks → planner.review() produces a
    // real tasks.md block that parseTasks will accept. The regenerate output is
    // distinctive text so we can observe it flowed through instead of the
    // initial plan's spec.
    const regenArgs: Array<{ prompt: string; target: string }> = [];
    const planner = makePassingPlanner({
      review: vi.fn().mockResolvedValue({ text: REAL_TASKS_MD, usage: null }),
      regenerate: async (opts) => {
        regenArgs.push({ prompt: opts.prompt, target: opts.artifactType });
        return { text: '# Regenerated Spec\n\nauth section added.\n', usage: null };
      },
    });

    const { result } = await runPhase({
      planner,
      callbacks,
      config: makeConfig({ workflow: manual() }),
    });

    expect(result.cancelled).toBe(false);
    expect(result.tasks).toHaveLength(1);
    expect(result.state.phase).toBe('implementing');
    expect(regenArgs).toHaveLength(1);
    expect(regenArgs[0]?.prompt).toContain('add auth section');
    expect(regenArgs[0]?.target).toBe('spec');
  });

  it('enters reviewing-briefs phase for invalid briefs in standard mode (user can reject)', async () => {
    const { projectDir, sessionId } = setupProject();
    const planner = makePassingPlanner({
      plan: vi.fn().mockResolvedValue({
        spec: '# Spec',
        plan: '# Plan',
        tasks: [makeBriefQualityFailureTask()],
        usage: { inputTokens: 100, outputTokens: 50 },
      }),
    });
    const onApprovalNeeded = sequencedApproval([{ approved: true }, { approved: false }]);
    const { callbacks } = makeCallbacks({ onApprovalNeeded });
    const { bus, events } = makeBusRecorder();
    const config = makeConfig({
      workflow: { mode: 'standard', autoApproveSpec: true, autoApprovePlan: true },
    });
    const initial = createInitialState('feature');

    const result = await runPlanningPhase({
      wctx: {
        projectDir,
        config,
        callbacks,
        metadata: TEST_METADATA,
        sessionId,
        bus,
        sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
      },
      planner,
      state: { ...initial, phase: 'idle' },
      feature: 'feature',
    });

    expect(result.cancelled).toBe(true);
    expect(result.state.phase).toBe('idle');
    const reportPath = join(sessionDir(projectDir, sessionId), BRIEF_QUALITY_FILE);
    expect(existsSync(reportPath)).toBe(true);
    const persisted = JSON.parse(readFileSync(reportPath, 'utf8'));
    expect(persisted.passed).toBe(false);
    const failed = events.find((e) => e.type === 'brief_quality_failed');
    expect(failed).toBeDefined();
  });

  it('standard mode blocks approval when persisted tasks.md fails quality', async () => {
    const { projectDir, sessionId } = setupProject();
    const planner = makePlanner({
      plan: vi.fn().mockResolvedValue({
        spec: '# Spec',
        plan: '# Plan',
        tasks: [makeBriefQualityFailureTask()],
        usage: { inputTokens: 100, outputTokens: 50 },
      }),
    });
    const onApprovalNeeded = sequencedApproval([
      { approved: true },
      { approved: true },
      { approved: false },
    ]);
    const { callbacks } = makeCallbacks({ onApprovalNeeded });
    const { bus, events } = makeBusRecorder();
    const config = makeConfig({
      workflow: { mode: 'standard', autoApproveSpec: true, autoApprovePlan: true },
    });

    const result = await runPlanningPhase({
      wctx: {
        projectDir,
        config,
        callbacks,
        metadata: TEST_METADATA,
        sessionId,
        bus,
        sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
      },
      planner,
      state: { ...createInitialState('feature'), phase: 'idle' },
      feature: 'feature',
    });

    expect(result.cancelled).toBe(true);
    expect(result.state.phase).toBe('idle');
    expect(events.filter((e) => e.type === 'brief_quality_failed').length).toBeGreaterThanOrEqual(
      2,
    );
  });

  it('brief edit reloads persisted tasks.md and quality-gates it before approval', async () => {
    const { projectDir, sessionId } = setupProject();
    const planner = makePassingPlanner();
    const tasksPath = join(sessionDir(projectDir, sessionId), TASKS_FILE);
    const onApprovalNeeded = vi
      .fn<OrchestratorCallbacks['onApprovalNeeded']>()
      .mockResolvedValueOnce({ approved: true })
      .mockImplementationOnce(async () => {
        writeFileSync(tasksPath, REAL_TASKS_MD, 'utf8');
        return { approved: false, action: 'edit' };
      })
      .mockResolvedValueOnce({ approved: true });
    const { callbacks } = makeCallbacks({ onApprovalNeeded });
    const config = makeConfig({
      workflow: { mode: 'standard', autoApproveSpec: true, autoApprovePlan: true },
    });

    const result = await runPlanningPhase({
      wctx: {
        projectDir,
        config,
        callbacks,
        metadata: TEST_METADATA,
        sessionId,
        bus: makeBusRecorder().bus,
        sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
      },
      planner,
      state: { ...createInitialState('feature'), phase: 'idle' },
      feature: 'feature',
    });

    expect(result.cancelled).toBe(false);
    expect(result.state.phase).toBe('implementing');
    expect(result.tasks[0]?.title).toBe('Add auth');
  });

  it('approve rewrites missing tasks.md from current tasks and reparses once', async () => {
    const { projectDir, sessionId } = setupProject();
    const planner = makePassingPlanner();
    const tasksPath = join(sessionDir(projectDir, sessionId), TASKS_FILE);
    const onApprovalNeeded = vi
      .fn<OrchestratorCallbacks['onApprovalNeeded']>()
      .mockResolvedValueOnce({ approved: true })
      .mockImplementationOnce(async () => {
        rmSync(tasksPath, { force: true });
        return { approved: true };
      });
    const { callbacks } = makeCallbacks({ onApprovalNeeded });
    const config = makeConfig({
      workflow: { mode: 'standard', autoApproveSpec: true, autoApprovePlan: true },
    });

    const result = await runPlanningPhase({
      wctx: {
        projectDir,
        config,
        callbacks,
        metadata: TEST_METADATA,
        sessionId,
        bus: makeBusRecorder().bus,
        sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
      },
      planner,
      state: { ...createInitialState('feature'), phase: 'idle' },
      feature: 'feature',
    });

    expect(result.cancelled).toBe(false);
    expect(result.state.phase).toBe('implementing');
    expect(existsSync(tasksPath)).toBe(true);
  });

  it('approve keeps review open when persisted tasks.md is empty', async () => {
    const { projectDir, sessionId } = setupProject();
    const planner = makePassingPlanner();
    const tasksPath = join(sessionDir(projectDir, sessionId), TASKS_FILE);
    const onApprovalNeeded = vi
      .fn<OrchestratorCallbacks['onApprovalNeeded']>()
      .mockResolvedValueOnce({ approved: true })
      .mockImplementationOnce(async () => {
        writeFileSync(tasksPath, '', 'utf8');
        return { approved: true };
      })
      .mockResolvedValueOnce({ approved: false });
    const { callbacks } = makeCallbacks({ onApprovalNeeded });
    const config = makeConfig({
      workflow: { mode: 'standard', autoApproveSpec: true, autoApprovePlan: true },
    });

    const result = await runPlanningPhase({
      wctx: {
        projectDir,
        config,
        callbacks,
        metadata: TEST_METADATA,
        sessionId,
        bus: makeBusRecorder().bus,
        sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
      },
      planner,
      state: { ...createInitialState('feature'), phase: 'idle' },
      feature: 'feature',
    });

    expect(result.cancelled).toBe(true);
    expect(result.state.phase).toBe('idle');
  });

  it('blocks invalid briefs before implementing in quick mode', async () => {
    const { projectDir, sessionId } = setupProject();
    const planner = makePassingPlanner({
      quickPlan: vi.fn().mockResolvedValue({
        spec: '# Spec',
        plan: '# Plan',
        tasks: [makeBriefQualityFailureTask()],
        usage: { inputTokens: 50, outputTokens: 25 },
      }),
    });
    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();
    const config = makeConfig({
      workflow: { mode: 'quick', autoApproveSpec: true, autoApprovePlan: true },
    });
    const initial = createInitialState('feature');

    const result = await runPlanningPhase({
      wctx: {
        projectDir,
        config,
        callbacks,
        metadata: TEST_METADATA,
        sessionId,
        bus,
        sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
      },
      planner,
      state: { ...initial, phase: 'idle' },
      feature: 'feature',
    });

    expectBriefQualityBlocked(result, projectDir, sessionId, events);
  });

  it('briefs comment → tasks regenerated via planner.review, loop continues, user then approves', async () => {
    const { projectDir, sessionId } = setupProject();
    const reviewPrompts: string[] = [];
    const planner = makePassingPlanner({
      review: async (prompt: string) => {
        reviewPrompts.push(prompt);
        return { text: REAL_TASKS_MD, usage: null };
      },
    });
    const onApprovalNeeded = sequencedApproval([
      { approved: true },
      { approved: false, comment: 'add scope definitions to all tasks' },
      { approved: true },
    ]);
    const { callbacks } = makeCallbacks({ onApprovalNeeded });
    const { bus } = makeBusRecorder();
    const config = makeConfig({
      workflow: { mode: 'standard', autoApproveSpec: true, autoApprovePlan: true },
    });
    const initial = createInitialState('feature');

    const result = await runPlanningPhase({
      wctx: {
        projectDir,
        config,
        callbacks,
        metadata: TEST_METADATA,
        sessionId,
        bus,
        sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
      },
      planner,
      state: { ...initial, phase: 'idle' },
      feature: 'feature',
    });

    expect(result.cancelled).toBe(false);
    expect(result.state.phase).toBe('implementing');
    expect(result.tasks).toHaveLength(1);
    expect(reviewPrompts).toEqual([expect.stringContaining('add scope definitions to all tasks')]);
  });
});

describe('runPlanningPhase — planner rejection context', () => {
  const feature = 'implement audited API sync';
  const rejectionSummary =
    '[sticky] network: fetch https://api.example.com/audit (reason: user denied network access)';

  async function runSeededPlanning(opts: {
    workflow: Partial<Config['workflow']>;
    planner: Planner;
    approval?: Config['approval'] | undefined;
  }) {
    const { projectDir, sessionId } = setupProject();
    seedRejectionEvidence(projectDir, sessionId);
    const config = makeConfig({
      workflow: { autoApproveSpec: true, autoApprovePlan: true, ...opts.workflow },
      ...(opts.approval ? { approval: opts.approval } : {}),
    });
    const result = await runPlanningPhase({
      wctx: {
        projectDir,
        config,
        callbacks: makeCallbacks().callbacks,
        metadata: TEST_METADATA,
        sessionId,
        bus: makeBusRecorder().bus,
        sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
      },
      planner: opts.planner,
      state: { ...createInitialState(feature), phase: 'idle' },
      feature,
    });
    return result;
  }

  it('prepends prior rejection context to standard planner input by default', async () => {
    const prompts: string[] = [];
    const plan: Planner['plan'] = async (opts) => {
      prompts.push(opts.feature);
      return makePassingPlanner().plan(opts);
    };
    const planner = makePassingPlanner({ plan });

    const result = await runSeededPlanning({
      workflow: { mode: 'standard' },
      planner,
    });

    expect(result.cancelled).toBe(false);
    expect(prompts).toEqual([expect.stringContaining('Previous rejections:')]);
    expect(prompts[0]).toContain(rejectionSummary);
    expect(prompts[0]).toContain(feature);
  });

  it('prepends prior rejection context to quick planner input when enabled', async () => {
    const prompts: string[] = [];
    const quickPlan: Planner['quickPlan'] = async (opts) => {
      prompts.push(opts.feature);
      return {
        spec: '',
        plan: '',
        tasks: [makePassingTask('T-QUICK')],
        usage: { inputTokens: 50, outputTokens: 25 },
      };
    };
    const planner = makePassingPlanner({ quickPlan });

    const result = await runSeededPlanning({
      workflow: { mode: 'quick' },
      planner,
      approval: { enabled: true, feedRejectionsToPlanner: true },
    });

    expect(result.cancelled).toBe(false);
    expect(prompts).toEqual([expect.stringContaining('Previous rejections:')]);
    expect(prompts[0]).toContain(rejectionSummary);
    expect(prompts[0]).toContain(feature);
  });

  it('does not include prior rejection context when feedRejectionsToPlanner is false', async () => {
    const prompts: string[] = [];
    const plan: Planner['plan'] = async (opts) => {
      prompts.push(opts.feature);
      return makePassingPlanner().plan(opts);
    };
    const planner = makePassingPlanner({ plan });

    const result = await runSeededPlanning({
      workflow: { mode: 'standard' },
      planner,
      approval: { enabled: true, feedRejectionsToPlanner: false },
    });

    expect(result.cancelled).toBe(false);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).not.toContain('Previous rejections:');
    expect(prompts[0]).not.toContain(rejectionSummary);
    expect(prompts[0]).toContain(feature);
  });
});

describe('runPlanningPhase — rejection paths', () => {
  const rejectCases: Array<{
    name: string;
    workflow: Partial<Config['workflow']>;
    approvals: Array<{ approved: boolean }>;
    expectPhase?: WorkflowState['phase'];
  }> = [
    {
      name: 'user rejects spec → cancelled, zero tasks, phase idle',
      workflow: manual(),
      approvals: [{ approved: false }],
      expectPhase: 'idle',
    },
    {
      name: 'user rejects plan (speckit mode) → cancelled',
      workflow: manual('speckit'),
      approvals: [{ approved: true }, { approved: false }],
    },
  ];

  it.each(rejectCases)('$name', async ({ workflow, approvals, expectPhase }) => {
    const { callbacks } = makeCallbacks({ onApprovalNeeded: sequencedApproval(approvals) });
    const { result } = await runPhase({ callbacks, config: makeConfig({ workflow }) });

    expect(result.cancelled).toBe(true);
    if (expectPhase !== undefined) {
      expect(result.tasks).toHaveLength(0);
      expect(result.state.phase).toBe(expectPhase);
    }
  });
});

describe('runPlanningPhase — persistence', () => {
  it('writes artifact text (not raw stdout) to disk', async () => {
    const { existsSync, readFileSync } = await import('node:fs');
    const { sessionDir, SPEC_FILE, PLAN_FILE } = await import('../../core/paths.js');
    const { join } = await import('node:path');

    const artifactSpec = '# Resolved Spec\n\nAdd authentication.\n';
    const artifactPlan = '# Resolved Plan\n\nUse JWT.\n';
    const plan = vi.fn().mockResolvedValue({
      spec: artifactSpec,
      plan: artifactPlan,
      tasks: [makePassingTask()],
      usage: { inputTokens: 100, outputTokens: 50 },
      phases: [
        { text: artifactSpec, filename: 'spec.md', rawOutput: 'raw planner noise for spec' },
        { text: artifactPlan, filename: 'plan.md', rawOutput: 'raw planner noise for plan' },
      ],
    });

    const { projectDir, sessionId } = await runPhase({
      planner: makePassingPlanner({ plan }),
      config: makeConfig({ workflow: auto() }),
    });

    const specPath = join(sessionDir(projectDir, sessionId), SPEC_FILE);
    const planPath = join(sessionDir(projectDir, sessionId), PLAN_FILE);
    expect(existsSync(specPath)).toBe(true);
    expect(existsSync(planPath)).toBe(true);
    expect(readFileSync(specPath, 'utf-8')).toContain('Add authentication');
    expect(readFileSync(specPath, 'utf-8')).not.toContain('raw planner noise');
    expect(readFileSync(planPath, 'utf-8')).toContain('Use JWT');
    expect(readFileSync(planPath, 'utf-8')).not.toContain('raw planner noise');
  });
});

describe('runPlanningPhase — onQuestion wiring', () => {
  const onQuestionCases: Array<{
    name: string;
    supports: boolean;
    expectedType: 'undefined' | 'function';
  }> = [
    {
      name: 'no onQuestion passed when capability is false',
      supports: false,
      expectedType: 'undefined',
    },
    { name: 'onQuestion wired when capability is true', supports: true, expectedType: 'function' },
  ];

  it.each(onQuestionCases)('$name', async ({ supports, expectedType }) => {
    let captured: unknown;
    const plan = vi.fn().mockImplementation(async (opts) => {
      captured = opts.callbacks.onQuestion;
      return { spec: '', plan: '', tasks: [makePassingTask()], usage: null };
    });
    const planner = makePassingPlanner({
      plan,
      ...(supports
        ? {
            capabilities: {
              supportsConversationalPlanning: true,
              supportsHintEscalation: true,
              supportsSessionResume: false,
              supportsEffort: false,
              supportsImages: false,
              supportsSelfSummarisation: false,
            },
          }
        : {}),
    });

    const { result } = await runPhase({ planner, config: makeConfig({ workflow: auto() }) });

    expect(result.cancelled).toBe(false);
    if (expectedType === 'undefined') expect(captured).toBeUndefined();
    else expect(captured).toBeTypeOf('function');
  });
});

describe('runPlanningPhase — abort + continuation', () => {
  const abortCases: Array<{
    name: string;
    fnKey: 'plan' | 'quickPlan';
    workflow: Partial<Config['workflow']>;
    partialText: string;
    continuationText: string;
  }> = [
    {
      name: 'standard mode: plan() aborts → continuation carries partial + user text',
      fnKey: 'plan',
      workflow: auto(),
      partialText: 'partially generated spec...',
      continuationText: 'also use PostgreSQL 15',
    },
    {
      name: 'quick mode: quickPlan() aborts → continuation carries partial + user text',
      fnKey: 'quickPlan',
      workflow: manual('quick'),
      partialText: 'quick plan partial output',
      continuationText: 'add more detail',
    },
  ];

  it.each(abortCases)('$name', async ({ fnKey, workflow, partialText, continuationText }) => {
    const sinks = createTestSinks();
    let callCount = 0;
    const fn: Planner['plan'] = async ({ feature, callbacks: plannerCbs }) => {
      callCount++;
      if (callCount === 1) {
        plannerCbs.onOutput(partialText);
        sinks.abortTurn();
        throw new DOMException('The user aborted a request.', 'AbortError');
      }
      expect(feature).toContain(partialText);
      expect(feature).toContain(continuationText);
      return fnKey === 'quickPlan'
        ? {
            spec: '',
            plan: '',
            tasks: [makePassingTask()],
            usage: { inputTokens: 50, outputTokens: 25 },
          }
        : {
            spec: '# Full Spec',
            plan: '# Full Plan',
            tasks: [makePassingTask()],
            usage: { inputTokens: 100, outputTokens: 50 },
          };
    };

    const continuationPrompts: string[] = [];
    const onContinuationNeeded = async (partial: string) => {
      continuationPrompts.push(partial);
      return continuationText;
    };
    const { callbacks } = makeCallbacks({ onContinuationNeeded });
    const planner = makePassingPlanner({ [fnKey]: fn });

    const { result } = await runPhase({
      planner,
      callbacks,
      config: makeConfig({ workflow }),
      sinks,
    });

    expect(result.cancelled).toBe(false);
    expect(continuationPrompts).toEqual([partialText]);
    expect(callCount).toBe(2);
  });

  it('abort without onContinuationNeeded falls through to planning failure', async () => {
    const sinks = createTestSinks();
    let planCalls = 0;
    const plan = async () => {
      planCalls++;
      sinks.abortTurn();
      throw new DOMException('The user aborted a request.', 'AbortError');
    };
    const { callbacks } = makeCallbacks({ onContinuationNeeded: undefined });

    const { result } = await runPhase({
      planner: makePassingPlanner({ plan }),
      callbacks,
      config: makeConfig({ workflow: auto() }),
      sinks,
    });

    expect(result.cancelled).toBe(true);
    expect(planCalls).toBe(1);
  });
});

describe('runPlanningPhase — rewindPending', () => {
  const rewindRegenCases: Array<{
    target: 'spec' | 'plan';
    phase: 'specifying' | 'planning';
    comment: string;
  }> = [
    { target: 'spec', phase: 'specifying', comment: 'add httpOnly cookie flag' },
    { target: 'plan', phase: 'planning', comment: 'add caching layer' },
  ];

  it.each(
    rewindRegenCases,
  )('rewindPending target=$target with comment triggers regenerate', async ({
    target,
    phase,
    comment,
  }) => {
    const regenCalls: Array<{ prompt: string; target: string }> = [];
    let planCalls = 0;
    const planner = makePassingPlanner({
      review: vi.fn().mockResolvedValue({ text: REAL_TASKS_MD, usage: null }),
      regenerate: async (opts) => {
        regenCalls.push({ prompt: opts.prompt, target: opts.artifactType });
        return { text: 'regenerated', usage: null };
      },
      plan: async () => {
        planCalls++;
        return {
          spec: '# Spec',
          plan: '# Plan',
          tasks: [makePassingTask()],
          usage: { inputTokens: 100, outputTokens: 50 },
        };
      },
    });
    const { result } = await runPhase({
      planner,
      config: makeConfig({ workflow: auto() }),
      state: prepareState(phase),
      rewindPending: { target, comment },
    });

    expect(result.cancelled).toBe(false);
    expect(regenCalls).toHaveLength(1);
    expect(regenCalls[0]?.prompt).toContain(comment);
    expect(regenCalls[0]?.target).toBe(target);
    expect(planCalls).toBe(0);
  });

  const rewindRejectCases: Array<{
    target: 'spec' | 'plan';
    phase: 'specifying' | 'planning';
    mode?: 'speckit';
  }> = [
    { target: 'spec', phase: 'specifying' },
    { target: 'plan', phase: 'planning', mode: 'speckit' },
  ];

  it.each(
    rewindRejectCases,
  )('rewindPending target=$target — rejected during approval → cancelled', async ({
    target,
    phase,
    mode,
  }) => {
    const { callbacks } = makeCallbacks({
      onApprovalNeeded: vi.fn().mockResolvedValue({ approved: false }),
    });
    let planCalls = 0;
    const planner = makePassingPlanner({
      plan: async () => {
        planCalls++;
        return {
          spec: '# Spec',
          plan: '# Plan',
          tasks: [makePassingTask()],
          usage: { inputTokens: 100, outputTokens: 50 },
        };
      },
    });

    const { result } = await runPhase({
      planner,
      callbacks,
      config: makeConfig({ workflow: manual(mode) }),
      state: prepareState(phase),
      rewindPending: { target, comment: 'reject me' },
    });

    expect(result.cancelled).toBe(true);
    expect(result.tasks).toHaveLength(0);
    expect(planCalls).toBe(0);
  });

  it('rewindPending without comment skips regen and runs from rewound phase', async () => {
    // Rewind fast-path still calls regeneratePlanAndTasks → planner.review() → parseTasks().
    let regenCalls = 0;
    let planCalls = 0;
    const planner = makePassingPlanner({
      review: vi.fn().mockResolvedValue({ text: REAL_TASKS_MD, usage: null }),
      regenerate: async () => {
        regenCalls++;
        return { text: 'regenerated', usage: null };
      },
      plan: async () => {
        planCalls++;
        return {
          spec: '# Spec',
          plan: '# Plan',
          tasks: [makePassingTask()],
          usage: { inputTokens: 100, outputTokens: 50 },
        };
      },
    });

    const { result } = await runPhase({
      planner,
      config: makeConfig({ workflow: auto() }),
      state: prepareState('specifying'),
      rewindPending: { target: 'spec' },
    });

    expect(result.cancelled).toBe(false);
    expect(regenCalls).toBe(0);
    expect(planCalls).toBe(0);
    expect(result.tasks).toHaveLength(1);
  });

  it('rewind plan requires brief approval before implementation', async () => {
    const onApprovalNeeded = vi.fn().mockResolvedValue({ approved: false });
    const { callbacks } = makeCallbacks({ onApprovalNeeded });
    const planner = makePassingPlanner({
      review: vi.fn().mockResolvedValue({ text: REAL_TASKS_MD, usage: null }),
    });

    const { result } = await runPhase({
      planner,
      callbacks,
      config: makeConfig({ workflow: auto() }),
      state: prepareState('planning'),
      rewindPending: { target: 'plan' },
    });

    expect(result.cancelled).toBe(true);
    expect(result.state.phase).not.toBe('implementing');
    expect(result.tasks).toHaveLength(0);
    expect(onApprovalNeeded).toHaveBeenCalledWith('briefs', expect.stringContaining(TASKS_FILE));
  });

  it('rewind approval reaches implementation through briefs, not plan approval', async () => {
    const onApprovalNeeded = vi.fn().mockResolvedValue({ approved: true });
    const { callbacks } = makeCallbacks({ onApprovalNeeded });
    const planner = makePassingPlanner({
      review: vi.fn().mockResolvedValue({ text: REAL_TASKS_MD, usage: null }),
    });

    const { result, events } = await runPhase({
      planner,
      callbacks,
      config: makeConfig({ workflow: auto() }),
      state: prepareState('planning'),
      rewindPending: { target: 'plan' },
    });

    expect(result.cancelled).toBe(false);
    expect(result.state.phase).toBe('implementing');
    expect(onApprovalNeeded).toHaveBeenCalledWith('briefs', expect.stringContaining(TASKS_FILE));
    expect(events.some((e) => e.type === 'plan_approved' && e.phase === 'implementing')).toBe(true);
  });

  it('rewindPending cleared on resulting state after regeneration', async () => {
    const { result } = await runPhase({
      planner: makePassingPlanner({
        review: vi.fn().mockResolvedValue({ text: REAL_TASKS_MD, usage: null }),
      }),
      config: makeConfig({ workflow: auto() }),
      state: {
        ...prepareState('specifying'),
        rewindPending: { target: 'spec', comment: 'use JWT' },
      },
      rewindPending: { target: 'spec', comment: 'use JWT' },
    });

    expect(result.cancelled).toBe(false);
    expect(result.state.rewindPending).toBeUndefined();
  });

  it('speckit mode new-planning (no rewind) invokes planner.plan exactly once', async () => {
    let planCalls = 0;
    let regenCalls = 0;
    const planner = makePassingPlanner({
      plan: async () => {
        planCalls++;
        // Distinctive task id proves these tasks came from plan(), not a stale
        // path. If plan() were called more than once, the result would come
        // from the last call but we assert the counter directly.
        return {
          spec: '# Spec',
          plan: '# Plan',
          tasks: [makePassingTask('T-FROMPLAN')],
          usage: { inputTokens: 100, outputTokens: 50 },
        };
      },
      regenerate: async () => {
        regenCalls++;
        return { text: 'regenerated', usage: null };
      },
    });
    const { result } = await runPhase({
      planner,
      config: makeConfig({ workflow: auto('speckit') }),
    });

    expect(result.cancelled).toBe(false);
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]?.id).toBe('T-FROMPLAN');
    expect(result.state.phase).toBe('implementing');
    expect(planCalls).toBe(1);
    expect(regenCalls).toBe(0);
  });
});
