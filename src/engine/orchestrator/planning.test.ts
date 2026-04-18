import { describe, it, expect, vi, afterEach } from 'vitest';
import type { WorkflowState } from '../../core/schemas/workflow.js';
import { createInitialState, transition } from '../../core/state/machine.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeCallbacks, makePlanner } from '#testing/helpers/orchestrator-factories.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { ensureSessionDir } from '../../core/paths-io.js';
import { runPlanningPhase } from './planning/run.js';
import type { WorkflowSinks } from './types.js';
import type { Planner } from '../planners/types.js';
import type { Config } from '../../core/schemas/config.js';
import type { OrchestratorCallbacks } from './types.js';

const TEST_METADATA = { plannerTool: 'claude-code', implementerTool: 'ollama', mode: 'standard' };

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
    setAbortHandler: (h) => { abortHandler = h; },
    setQueueHandler: () => {},
    abortTurn: () => {
      if (!abortHandler) return false;
      abortHandler();
      return true;
    },
  };
}

function prepareState(phase?: 'specifying' | 'planning', rewindPending?: WorkflowState['rewindPending']): WorkflowState {
  const initial = createInitialState('test-feature');
  if (phase) return { ...initial, phase, rewindPending };
  return transition(initial, { type: 'START', feature: 'test-feature' });
}

function sequencedApproval(responses: Array<{ approved: boolean; comment?: string }>): OrchestratorCallbacks['onApprovalNeeded'] {
  const fn = vi.fn<OrchestratorCallbacks['onApprovalNeeded']>();
  for (const r of responses) fn.mockResolvedValueOnce(r);
  return fn;
}

const auto = (mode?: Config['workflow']['mode']): Partial<Config['workflow']> =>
  ({ autoApproveSpec: true, autoApprovePlan: true, ...(mode ? { mode } : {}) });
const manual = (mode?: Config['workflow']['mode']): Partial<Config['workflow']> =>
  ({ autoApproveSpec: false, autoApprovePlan: false, ...(mode ? { mode } : {}) });

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
  const planner = opts.planner ?? makePlanner();
  const callbacks = opts.callbacks ?? makeCallbacks().callbacks;
  const config = opts.config ?? makeConfig();
  const state = opts.state ?? prepareState();
  const sinks = opts.sinks ?? createTestSinks();
  const result = await runPlanningPhase({
    wctx: { projectDir, config, callbacks, metadata: TEST_METADATA, sessionId, sinks },
    planner,
    state,
    feature: 'test-feature',
    ...(opts.rewindPending ? { rewindPending: opts.rewindPending } : {}),
  });
  return { result, projectDir, sessionId };
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
    { name: 'quick mode skips approval and uses quickPlan', workflow: manual('quick'), useQuickPlan: true },
    { name: 'standard mode uses single approval gate', workflow: manual('standard'), approvals: [{ approved: true }] },
    { name: 'full mode requires two approvals (spec + plan)', workflow: manual('full'), approvals: [{ approved: true }, { approved: true }] },
  ];

  it.each(happyCases)('$name', async ({ workflow, approvals, useQuickPlan }) => {
    const onApprovalNeeded = approvals ? sequencedApproval(approvals) : undefined;
    const { callbacks } = makeCallbacks(onApprovalNeeded ? { onApprovalNeeded } : undefined);
    const quickPlan = useQuickPlan
      ? vi.fn().mockResolvedValue({ spec: '', plan: '', tasks: [makeTask()], usage: { inputTokens: 50, outputTokens: 25 } })
      : undefined;
    const planner = makePlanner(quickPlan ? { quickPlan } : undefined);

    const { result } = await runPhase({ planner, callbacks, config: makeConfig({ workflow }) });

    expect(result.cancelled).toBe(false);
    expect(result.tasks).toHaveLength(1);
    expect(result.state.phase).toBe('implementing');
    if (useQuickPlan) expect(quickPlan).toHaveBeenCalledOnce();
  });

  it('user comment → spec regenerated, workflow completes', async () => {
    const onApprovalNeeded = sequencedApproval([
      { approved: false, comment: 'add auth section' },
      { approved: true },
      { approved: true },
    ]);
    const { callbacks } = makeCallbacks({ onApprovalNeeded });
    // After regeneration, regeneratePlanAndTasks → planner.review() produces a
    // real tasks.md block that parseTasks will accept.
    const planner = makePlanner({ review: vi.fn().mockResolvedValue({ text: REAL_TASKS_MD, usage: null }) });

    const { result } = await runPhase({ planner, callbacks, config: makeConfig({ workflow: manual() }) });

    expect(result.cancelled).toBe(false);
    expect(result.tasks).toHaveLength(1);
    expect(result.state.phase).toBe('implementing');
    expect(planner.regenerate).toHaveBeenCalled();
  });
});

describe('runPlanningPhase — rejection paths', () => {
  const rejectCases: Array<{
    name: string;
    workflow: Partial<Config['workflow']>;
    approvals: Array<{ approved: boolean }>;
    expectPhase?: WorkflowState['phase'];
  }> = [
    { name: 'user rejects spec → cancelled, zero tasks, phase idle', workflow: manual(), approvals: [{ approved: false }], expectPhase: 'idle' },
    { name: 'user rejects plan (full mode) → cancelled', workflow: manual('full'), approvals: [{ approved: true }, { approved: false }] },
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
      tasks: [makeTask()],
      usage: { inputTokens: 100, outputTokens: 50 },
      phases: [
        { text: artifactSpec, filename: 'spec.md', rawOutput: 'raw planner noise for spec' },
        { text: artifactPlan, filename: 'plan.md', rawOutput: 'raw planner noise for plan' },
      ],
    });

    const { projectDir, sessionId } = await runPhase({
      planner: makePlanner({ plan }),
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
  const onQuestionCases: Array<{ name: string; supports: boolean; expectedType: 'undefined' | 'function' }> = [
    { name: 'no onQuestion passed when capability is false', supports: false, expectedType: 'undefined' },
    { name: 'onQuestion wired when capability is true', supports: true, expectedType: 'function' },
  ];

  it.each(onQuestionCases)('$name', async ({ supports, expectedType }) => {
    let captured: unknown;
    const plan = vi.fn().mockImplementation(async (_feature, _dir, cbs) => {
      captured = cbs.onQuestion;
      return { spec: '', plan: '', tasks: [makeTask()], usage: null };
    });
    const planner = makePlanner({
      plan,
      ...(supports
        ? { capabilities: { supportsConversationalPlanning: true, supportsHintEscalation: true, supportsSessionResume: false } }
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
    { name: 'standard mode: plan() aborts → continuation carries partial + user text', fnKey: 'plan', workflow: auto(), partialText: 'partially generated spec...', continuationText: 'also use PostgreSQL 15' },
    { name: 'quick mode: quickPlan() aborts → continuation carries partial + user text', fnKey: 'quickPlan', workflow: manual('quick'), partialText: 'quick plan partial output', continuationText: 'add more detail' },
  ];

  it.each(abortCases)('$name', async ({ fnKey, workflow, partialText, continuationText }) => {
    const sinks = createTestSinks();
    let callCount = 0;
    const fn = vi.fn().mockImplementation(async (feature: string, _dir: string, plannerCbs: { onOutput: (t: string) => void }) => {
      callCount++;
      if (callCount === 1) {
        plannerCbs.onOutput(partialText);
        sinks.abortTurn();
        throw new DOMException('The user aborted a request.', 'AbortError');
      }
      expect(feature).toContain(partialText);
      expect(feature).toContain(continuationText);
      return fnKey === 'quickPlan'
        ? { spec: '', plan: '', tasks: [makeTask()], usage: { inputTokens: 50, outputTokens: 25 } }
        : { spec: '# Full Spec', plan: '# Full Plan', tasks: [makeTask()], usage: { inputTokens: 100, outputTokens: 50 } };
    });

    const onContinuationNeeded = vi.fn().mockResolvedValue(continuationText);
    const { callbacks } = makeCallbacks({ onContinuationNeeded });
    const planner = makePlanner({ [fnKey]: fn });

    const { result } = await runPhase({ planner, callbacks, config: makeConfig({ workflow }), sinks });

    expect(result.cancelled).toBe(false);
    expect(onContinuationNeeded).toHaveBeenCalledWith(partialText);
    expect(callCount).toBe(2);
  });

  it('abort without onContinuationNeeded falls through to planning failure', async () => {
    const sinks = createTestSinks();
    const plan = vi.fn().mockImplementation(async () => {
      sinks.abortTurn();
      throw new DOMException('The user aborted a request.', 'AbortError');
    });
    const { callbacks } = makeCallbacks({ onContinuationNeeded: undefined });

    const { result } = await runPhase({
      planner: makePlanner({ plan }),
      callbacks,
      config: makeConfig({ workflow: auto() }),
      sinks,
    });

    expect(result.cancelled).toBe(true);
    expect(plan).toHaveBeenCalledOnce();
  });
});

describe('runPlanningPhase — rewindPending', () => {
  const rewindRegenCases: Array<{ target: 'spec' | 'plan'; phase: 'specifying' | 'planning'; comment: string }> = [
    { target: 'spec', phase: 'specifying', comment: 'add httpOnly cookie flag' },
    { target: 'plan', phase: 'planning', comment: 'add caching layer' },
  ];

  it.each(rewindRegenCases)('rewindPending target=$target with comment triggers regenerate', async ({ target, phase, comment }) => {
    const planner = makePlanner();
    const { result } = await runPhase({
      planner,
      config: makeConfig({ workflow: auto() }),
      state: prepareState(phase),
      rewindPending: { target, comment },
    });

    expect(result.cancelled).toBe(false);
    expect(planner.regenerate).toHaveBeenCalledOnce();
    const regenCall = vi.mocked(planner.regenerate).mock.calls[0];
    expect(regenCall?.[0]).toContain(comment);
    expect(regenCall?.[1]).toBe(target);
    expect(planner.plan).not.toHaveBeenCalled();
  });

  const rewindRejectCases: Array<{ target: 'spec' | 'plan'; phase: 'specifying' | 'planning'; mode?: 'full' }> = [
    { target: 'spec', phase: 'specifying' },
    { target: 'plan', phase: 'planning', mode: 'full' },
  ];

  it.each(rewindRejectCases)('rewindPending target=$target — rejected during approval → cancelled', async ({ target, phase, mode }) => {
    const { callbacks } = makeCallbacks({ onApprovalNeeded: vi.fn().mockResolvedValue({ approved: false }) });
    const planner = makePlanner();

    const { result } = await runPhase({
      planner,
      callbacks,
      config: makeConfig({ workflow: manual(mode) }),
      state: prepareState(phase),
      rewindPending: { target, comment: 'reject me' },
    });

    expect(result.cancelled).toBe(true);
    expect(result.tasks).toHaveLength(0);
    expect(planner.plan).not.toHaveBeenCalled();
  });

  it('rewindPending without comment skips regen and runs from rewound phase', async () => {
    // Rewind fast-path still calls regeneratePlanAndTasks → planner.review() → parseTasks().
    const planner = makePlanner({ review: vi.fn().mockResolvedValue({ text: REAL_TASKS_MD, usage: null }) });

    const { result } = await runPhase({
      planner,
      config: makeConfig({ workflow: auto() }),
      state: prepareState('specifying'),
      rewindPending: { target: 'spec' },
    });

    expect(result.cancelled).toBe(false);
    expect(planner.regenerate).not.toHaveBeenCalled();
    expect(planner.plan).not.toHaveBeenCalled();
    expect(result.tasks).toHaveLength(1);
  });

  it('rewindPending cleared on resulting state after regeneration', async () => {
    const { result } = await runPhase({
      config: makeConfig({ workflow: auto() }),
      state: { ...prepareState('specifying'), rewindPending: { target: 'spec', comment: 'use JWT' } },
      rewindPending: { target: 'spec', comment: 'use JWT' },
    });

    expect(result.cancelled).toBe(false);
    expect(result.state.rewindPending).toBeUndefined();
  });

  it('full mode new-planning (no rewind) invokes planner.plan exactly once', async () => {
    const planner = makePlanner();
    const { result } = await runPhase({ planner, config: makeConfig({ workflow: auto('full') }) });

    expect(result.cancelled).toBe(false);
    expect(result.tasks).toHaveLength(1);
    expect(result.state.phase).toBe('implementing');
    expect(planner.plan).toHaveBeenCalledOnce();
    expect(planner.regenerate).not.toHaveBeenCalled();
  });
});
