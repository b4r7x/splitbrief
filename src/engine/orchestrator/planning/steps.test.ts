import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeConfig } from '#testing/helpers/factories/config.js';
import {
  makePhaseCallResult,
  PLANNER_DOCUMENT_FIXTURES,
} from '#testing/helpers/factories/phase-call.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import {
  makeBusRecorder,
  makeCallbacks,
  makePlanner,
  TEST_METADATA,
  TEST_SINKS,
} from '#testing/helpers/orchestrator-factories.js';
import { REAL_TASKS_MD, makePassingTask } from '#testing/helpers/planning-phase.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import {
  ANALYZE_FILE,
  CLARIFICATIONS_FILE,
  CONSTITUTION_CHECK_FILE,
  PLAN_FILE,
  RESEARCH_FILE,
  SPEC_FILE,
  TASKS_FILE,
  sessionDir,
} from '../../../core/paths.js';
import { ensureSessionDir, readSpecFile, writeSpecFile } from '../../../core/paths-io.js';
import { MODES } from '../../../core/pipeline-spec/modes.js';
import type { ApproveLevel, WorkflowMode } from '../../../core/schemas/enums.js';
import type { ClarificationQuestion } from '../../../core/schemas/question.js';
import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { createInitialState, transition } from '../../../core/state/machine.js';
import { loadState, saveState } from '../../../core/state/persistence.js';
import type { OrchestratorCallbacks } from '../types.js';
import type {
  PhaseInputs,
  Planner,
  PlannerDocumentCall,
  RunPhaseInput,
  PhaseCallResult,
} from '../../planners/types.js';
import { runPlanningSteps } from './steps.js';

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) cleanupTempDir(dir);
  dirs = [];
});

type Recorded = { call: PlannerDocumentCall; inputs: PhaseInputs };

function recordingPlanner(opts?: {
  texts?: Partial<Record<PlannerDocumentCall, string>>;
  tasks?: Task[];
  review?: Planner['review'];
}): { planner: Planner; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const planner = makePlanner({
    runPhase: vi.fn(async ({ call, inputs }: RunPhaseInput) => {
      calls.push({ call, inputs });
      const text = opts?.texts?.[call];
      return makePhaseCallResult({
        call,
        ...(text !== undefined ? { text } : {}),
        ...(call === 'tasks' ? { tasks: opts?.tasks ?? [makePassingTask()] } : {}),
      });
    }),
    ...(opts?.review ? { review: opts.review } : {}),
  });
  return { planner, calls };
}

function setupProject(mode: WorkflowMode): {
  projectDir: string;
  sessionId: string;
} {
  const projectDir = createTempDir(`planning-steps-${mode}`);
  dirs.push(projectDir);
  const sessionId = 'sess-steps';
  ensureSessionDir(projectDir, sessionId);
  return { projectDir, sessionId };
}

function stateFor(mode: WorkflowMode, overrides: Partial<WorkflowState> = {}): WorkflowState {
  return {
    ...transition(createInitialState('feat'), { type: 'START' }),
    mode,
    ...overrides,
  };
}

async function runSteps(opts: {
  mode: WorkflowMode;
  planner: Planner;
  project?: { projectDir: string; sessionId: string };
  state?: WorkflowState;
  approveLevel?: ApproveLevel;
  callbacks?: OrchestratorCallbacks;
  feature?: string;
  startAt?: 'research' | 'spec' | 'plan' | 'tasks';
  skillsContext?: string;
}) {
  const project = opts.project ?? setupProject(opts.mode);
  const state = opts.state ?? stateFor(opts.mode);
  const { bus, events } = makeBusRecorder();
  saveState({ projectDir: project.projectDir, sessionId: project.sessionId }, state);
  const result = await runPlanningSteps({
    wctx: {
      projectDir: project.projectDir,
      sessionId: project.sessionId,
      config: makeConfig({ workflow: { mode: opts.mode, approve: opts.approveLevel ?? 'none' } }),
      callbacks: opts.callbacks ?? makeCallbacks().callbacks,
      bus,
      metadata: TEST_METADATA,
      sinks: TEST_SINKS,
      ...(opts.skillsContext !== undefined && { skillsContext: opts.skillsContext }),
    },
    planner: opts.planner,
    state,
    feature: opts.feature ?? 'feat',
    approveLevel: opts.approveLevel ?? 'none',
    ...(opts.startAt !== undefined && { startAt: opts.startAt }),
  });
  return { result, events, ...project };
}

function seed(
  project: { projectDir: string; sessionId: string },
  files: Partial<Record<string, string>>,
): void {
  for (const [name, text] of Object.entries(files)) {
    if (text === undefined) continue;
    if (name.endsWith('.json')) {
      writeFileSync(join(sessionDir(project.projectDir, project.sessionId), name), text);
      continue;
    }
    writeSpecFile(project, name, text);
  }
}

describe('runPlanningSteps — one call per step', () => {
  it('standard spends one call per document, in order', async () => {
    const { planner, calls } = recordingPlanner();
    const { result, projectDir, sessionId } = await runSteps({ mode: 'standard', planner });

    expect(calls.map((entry) => entry.call)).toEqual(['research', 'spec', 'plan', 'tasks']);
    expect(result.disposition).toBe('tasks-ready');
    expect(readSpecFile({ projectDir, sessionId }, RESEARCH_FILE)).toContain('# Research');
    expect(readSpecFile({ projectDir, sessionId }, SPEC_FILE)).toContain('# Spec');
    expect(readSpecFile({ projectDir, sessionId }, PLAN_FILE)).toContain('# Plan');
    expect(readSpecFile({ projectDir, sessionId }, TASKS_FILE)).toContain('id: T001');
  });

  it('quick spends the single tasks call with the quick prompt inputs', async () => {
    const { planner, calls } = recordingPlanner();
    const { result } = await runSteps({
      mode: 'quick',
      planner,
      state: stateFor('quick', { phase: 'idle' }),
    });

    expect(calls.map((entry) => entry.call)).toEqual(['tasks']);
    expect(calls[0]?.inputs.quickPlan).toEqual({ trivial: false });
    expect(result.disposition).toBe('tasks-ready');
  });

  it('hands each call the artifacts the calls before it wrote', async () => {
    const { planner, calls } = recordingPlanner({
      texts: { research: '# Research\n\nFound it.', spec: '# Spec\n\nRequired.' },
    });
    await runSteps({ mode: 'standard', planner });

    const spec = calls.find((entry) => entry.call === 'spec');
    const plan = calls.find((entry) => entry.call === 'plan');
    const tasks = calls.find((entry) => entry.call === 'tasks');
    expect(spec?.inputs.research).toContain('Found it.');
    expect(plan?.inputs.spec).toContain('Required.');
    expect(tasks?.inputs.plan).toContain('# Plan');
    expect(tasks?.inputs.quickPlan).toBeUndefined();
  });

  it("hands the tasks call the mode's brief cap", async () => {
    const { planner, calls } = recordingPlanner();
    await runSteps({ mode: 'standard', planner });

    const tasks = calls.find((entry) => entry.call === 'tasks');
    expect(tasks?.inputs.briefCap).toBe(MODES.standard.briefCap);
    expect(calls.find((entry) => entry.call === 'plan')?.inputs.briefCap).toBeUndefined();
  });

  it('names the running call in the saved phase', async () => {
    const seenPhases: string[] = [];
    const project = setupProject('standard');
    const planner = makePlanner({
      runPhase: vi.fn(async ({ call }: RunPhaseInput) => {
        seenPhases.push(loadState(project)?.phase ?? 'missing');
        return makePhaseCallResult({
          call,
          ...(call === 'tasks' ? { tasks: [makePassingTask()] } : {}),
        });
      }),
    });

    await runSteps({ mode: 'standard', planner, project });

    expect(seenPhases).toEqual(['researching', 'specifying', 'planning', 'planning']);
    expect(loadState(project)?.phase).toBe('planning');
  });

  // Compiled briefs wait at the plan gate only in a run whose steps open it.
  it.each([
    ['quick', 'none', 'planning'],
    ['quick', 'all', 'planning'],
    ['standard', 'none', 'planning'],
    ['standard', 'spec', 'planning'],
    ['standard', 'plan', 'reviewing-plan'],
  ] as const)(
    'keeps the briefs of a %s run with approve %s in %s',
    async (mode, approveLevel, phase) => {
      const project = setupProject(mode);
      const { planner } = recordingPlanner();

      const { events } = await runSteps({ mode, planner, project, approveLevel });

      expect(loadState(project)?.phase).toBe(phase);
      expect(loadState(project)?.tasks.map((task) => task.id)).toEqual(['T001']);
      const announced = events.flatMap((event) =>
        event.type === 'planner_status' && event.call === undefined ? [event.phase] : [],
      );
      // A running status with no call announces a phase: only the plan gate is one to announce.
      expect(announced.filter((announcedPhase) => announcedPhase !== 'reviewing-spec')).toEqual(
        phase === 'reviewing-plan' ? ['reviewing-plan'] : [],
      );
    },
  );

  it('speckit adds clarify, constitution and analyze around the documents', async () => {
    const project = setupProject('speckit');
    const { planner, calls } = recordingPlanner({
      review: vi.fn().mockResolvedValue({
        text: '```json\n{"specTaskCoverage":1,"planTaskCoverage":1,"orphanTasks":[],"unaddressedSpecSections":[],"warnings":[]}\n```',
        usage: null,
      }),
    });

    const { result } = await runSteps({
      mode: 'speckit',
      planner,
      project,
      state: stateFor('speckit'),
    });

    expect(calls.map((entry) => entry.call)).toEqual(['research', 'spec', 'plan', 'tasks']);
    expect(
      existsSync(join(sessionDir(project.projectDir, project.sessionId), CLARIFICATIONS_FILE)),
    ).toBe(true);
    expect(
      existsSync(join(sessionDir(project.projectDir, project.sessionId), CONSTITUTION_CHECK_FILE)),
    ).toBe(true);
    expect(existsSync(join(sessionDir(project.projectDir, project.sessionId), ANALYZE_FILE))).toBe(
      true,
    );
    expect(result.disposition).toBe('tasks-ready');
  });
});

describe('runPlanningSteps — skills context', () => {
  it("hands every planner call the run's skills context", async () => {
    const skillsContext = '## Active Project Skills\n\n### AuthSkill\nPLAN-SKILL-BODY';
    const { planner, calls } = recordingPlanner();

    await runSteps({ mode: 'standard', planner, skillsContext });

    expect(calls.map((entry) => entry.call)).toEqual(['research', 'spec', 'plan', 'tasks']);
    for (const entry of calls) expect(entry.inputs.skillsContext).toBe(skillsContext);
  });

  it('omits the skills context when the run has none', async () => {
    const { planner, calls } = recordingPlanner();
    await runSteps({ mode: 'quick', planner });
    expect(calls[0]?.inputs.skillsContext).toBeUndefined();
  });
});

describe('runPlanningSteps — memoized steps', () => {
  it('skips a call whose artifact is already on disk', async () => {
    const project = setupProject('standard');
    seed(project, { [RESEARCH_FILE]: PLANNER_DOCUMENT_FIXTURES.research });
    const { planner, calls } = recordingPlanner();

    await runSteps({ mode: 'standard', planner, project });

    expect(calls.map((entry) => entry.call)).toEqual(['spec', 'plan', 'tasks']);
  });

  it('a run killed after research resumes at spec', async () => {
    const project = setupProject('standard');
    seed(project, { [RESEARCH_FILE]: PLANNER_DOCUMENT_FIXTURES.research });
    const { planner, calls } = recordingPlanner();

    await runSteps({
      mode: 'standard',
      planner,
      project,
      state: stateFor('standard', { phase: 'researching' }),
    });

    expect(calls[0]?.call).toBe('spec');
  });

  it('a run killed after the plan resumes at tasks', async () => {
    const project = setupProject('standard');
    seed(project, {
      [RESEARCH_FILE]: '# Research',
      [SPEC_FILE]: '# Spec',
      [PLAN_FILE]: '# Plan',
    });
    const { planner, calls } = recordingPlanner();

    const { result } = await runSteps({
      mode: 'standard',
      planner,
      project,
      state: stateFor('standard', { phase: 'planning' }),
    });

    expect(calls.map((entry) => entry.call)).toEqual(['tasks']);
    expect(result.disposition).toBe('tasks-ready');
  });

  it('a run with every artifact spends no call and reads the briefs from disk', async () => {
    const project = setupProject('standard');
    seed(project, {
      [RESEARCH_FILE]: '# Research',
      [SPEC_FILE]: '# Spec',
      [PLAN_FILE]: '# Plan',
      [TASKS_FILE]: REAL_TASKS_MD,
    });
    const { planner, calls } = recordingPlanner();

    const { result } = await runSteps({
      mode: 'standard',
      planner,
      project,
      state: stateFor('standard', { phase: 'planning' }),
    });

    expect(calls).toHaveLength(0);
    expect(result.disposition).toBe('tasks-ready');
    if (result.disposition !== 'tasks-ready') return;
    expect(result.tasks.map((task) => task.id)).toEqual(['T001']);
  });

  it('a speckit run killed before analyze re-issues only the analyze call', async () => {
    const project = setupProject('speckit');
    seed(project, {
      [RESEARCH_FILE]: '# Research',
      [SPEC_FILE]: '# Spec',
      [CLARIFICATIONS_FILE]: '# Clarifications',
      [CONSTITUTION_CHECK_FILE]: '{"passed":true,"violations":[]}',
      [PLAN_FILE]: '# Plan',
      [TASKS_FILE]: REAL_TASKS_MD,
    });
    const review = vi.fn().mockResolvedValue({
      text: '```json\n{"specTaskCoverage":1,"planTaskCoverage":1,"orphanTasks":[],"unaddressedSpecSections":[],"warnings":[]}\n```',
      usage: null,
    });
    const { planner, calls } = recordingPlanner({ review });

    await runSteps({
      mode: 'speckit',
      planner,
      project,
      state: stateFor('speckit', { phase: 'planning' }),
    });

    expect(calls).toHaveLength(0);
    expect(review).toHaveBeenCalledTimes(1);
    expect(existsSync(join(sessionDir(project.projectDir, project.sessionId), ANALYZE_FILE))).toBe(
      true,
    );
  });

  it('a call that runs again invalidates the artifacts below it', async () => {
    const project = setupProject('standard');
    seed(project, {
      [RESEARCH_FILE]: '# Research',
      [SPEC_FILE]: '# Spec',
      [TASKS_FILE]: REAL_TASKS_MD,
    });
    const { planner, calls } = recordingPlanner();

    await runSteps({
      mode: 'standard',
      planner,
      project,
      state: stateFor('standard', { phase: 'planning' }),
    });

    expect(calls.map((entry) => entry.call)).toEqual(['plan', 'tasks']);
  });
});

describe('runPlanningSteps — gates', () => {
  it('opens the spec gate after the spec call and parks the phase at reviewing-spec', async () => {
    const seenPhases: string[] = [];
    const project = setupProject('standard');
    const onApprovalNeeded = vi.fn(async () => {
      seenPhases.push(loadState(project)?.phase ?? 'missing');
      return { approved: true as const };
    });
    const { planner, calls } = recordingPlanner();

    await runSteps({
      mode: 'standard',
      planner,
      project,
      approveLevel: 'spec',
      callbacks: makeCallbacks({ onApprovalNeeded }).callbacks,
    });

    expect(onApprovalNeeded).toHaveBeenCalledTimes(1);
    expect(onApprovalNeeded).toHaveBeenCalledWith('spec', expect.anything());
    expect(seenPhases).toEqual(['reviewing-spec']);
    expect(calls.map((entry) => entry.call)).toEqual(['research', 'spec', 'plan', 'tasks']);
  });

  it('re-opens a parked spec gate without re-running the spec call', async () => {
    const project = setupProject('standard');
    seed(project, { [RESEARCH_FILE]: '# Research', [SPEC_FILE]: '# Spec' });
    const onApprovalNeeded = vi.fn().mockResolvedValue({ approved: true });
    const { planner, calls } = recordingPlanner();

    await runSteps({
      mode: 'standard',
      planner,
      project,
      approveLevel: 'spec',
      state: stateFor('standard', { phase: 'reviewing-spec' }),
      callbacks: makeCallbacks({ onApprovalNeeded }).callbacks,
    });

    expect(onApprovalNeeded).toHaveBeenCalledWith('spec', expect.stringContaining(SPEC_FILE));
    expect(calls.map((entry) => entry.call)).toEqual(['plan', 'tasks']);
  });

  it('a revised spec invalidates the plan and the briefs and re-runs them once', async () => {
    const project = setupProject('standard');
    seed(project, {
      [RESEARCH_FILE]: '# Research',
      [SPEC_FILE]: '# Spec',
      [PLAN_FILE]: '# Plan',
      [TASKS_FILE]: REAL_TASKS_MD,
    });
    const onApprovalNeeded = vi
      .fn()
      .mockResolvedValueOnce({ approved: false, action: 'revise', comment: 'tighten the scope' })
      .mockResolvedValue({ approved: true });
    const { planner, calls } = recordingPlanner();

    await runSteps({
      mode: 'standard',
      planner,
      project,
      approveLevel: 'spec',
      state: stateFor('standard', { phase: 'reviewing-spec' }),
      callbacks: makeCallbacks({ onApprovalNeeded }).callbacks,
    });

    expect(calls.map((entry) => entry.call)).toEqual(['plan', 'tasks']);
    expect(onApprovalNeeded).toHaveBeenCalledTimes(2);
  });

  it('ending the run at a gate returns closed', async () => {
    const onApprovalNeeded = vi.fn().mockResolvedValue({ approved: false, action: 'end-run' });
    const { planner } = recordingPlanner();

    const { result } = await runSteps({
      mode: 'standard',
      planner,
      approveLevel: 'spec',
      callbacks: makeCallbacks({ onApprovalNeeded }).callbacks,
    });

    expect(result).toMatchObject({ disposition: 'terminal', outcome: 'closed' });
  });

  it('a passed gate never re-opens when the loop re-scans', async () => {
    const project = setupProject('standard');
    const onApprovalNeeded = vi
      .fn()
      .mockResolvedValueOnce({ approved: false, action: 'revise', comment: 'again' })
      .mockResolvedValue({ approved: true });
    const { planner } = recordingPlanner();

    await runSteps({
      mode: 'standard',
      planner,
      project,
      approveLevel: 'spec',
      callbacks: makeCallbacks({ onApprovalNeeded }).callbacks,
    });

    expect(onApprovalNeeded).toHaveBeenCalledTimes(2);
  });
});

describe('runPlanningSteps — clarifications', () => {
  it('answers the conversational spec turn before producing artifacts', async () => {
    const project = setupProject('standard');
    const question: ClarificationQuestion = { id: 'q1', type: 'input', text: 'Which module?' };
    const calls: Recorded[] = [];
    const planner = makePlanner({
      runPhase: vi.fn(async ({ call, inputs }: RunPhaseInput): Promise<PhaseCallResult> => {
        calls.push({ call, inputs });
        if (call === 'spec' && calls.filter((entry) => entry.call === 'spec').length === 1) {
          return { kind: 'conversation', text: question.text, questions: [question], usage: null };
        }
        return makePhaseCallResult({
          call,
          ...(call === 'tasks' ? { tasks: [makePassingTask()] } : {}),
        });
      }),
    });
    const onPlannerReply = vi.fn().mockResolvedValue('the auth module');

    await runSteps({
      mode: 'standard',
      planner,
      project,
      callbacks: makeCallbacks({ onPlannerReply }).callbacks,
    });

    expect(onPlannerReply).toHaveBeenCalledWith(expect.objectContaining({ questions: [question] }));
    expect(calls.map((entry) => entry.call)).toEqual(['research', 'spec', 'spec', 'plan', 'tasks']);
    expect(calls[2]?.inputs.promptSuffix).toContain('the auth module');
  });

  it('an unanswered conversation parks without generating later documents', async () => {
    const question: ClarificationQuestion = { id: 'q1', type: 'confirm', text: 'Proceed?' };
    const calls: Recorded[] = [];
    const planner = makePlanner({
      runPhase: vi.fn(async ({ call, inputs }: RunPhaseInput): Promise<PhaseCallResult> => {
        calls.push({ call, inputs });
        if (call === 'spec')
          return { kind: 'conversation', text: question.text, questions: [question], usage: null };
        return makePhaseCallResult({
          call,
          ...(call === 'tasks' ? { tasks: [makePassingTask()] } : {}),
        });
      }),
    });
    const onPlannerReply = vi.fn().mockResolvedValue(undefined);

    const { result } = await runSteps({
      mode: 'standard',
      planner,
      callbacks: makeCallbacks({ onPlannerReply }).callbacks,
    });

    expect(onPlannerReply).toHaveBeenCalledTimes(1);
    expect(calls.map((entry) => entry.call)).toEqual(['research', 'spec']);
    expect(result).toMatchObject({ disposition: 'terminal', outcome: 'input-required' });
  });
});

describe('runPlanningSteps — halts', () => {
  it('a tasks call with no parsable brief halts for a decision', async () => {
    const { planner } = recordingPlanner({ tasks: [] });

    const { result, projectDir, sessionId } = await runSteps({ mode: 'quick', planner });

    expect(result).toMatchObject({ disposition: 'terminal', outcome: 'halted' });
    expect(loadState({ projectDir, sessionId })?.pendingRecovery?.reason).toBe(
      'planner-returned-no-briefs',
    );
  });

  it('a failed planner call halts with a recovery instead of ending the run', async () => {
    const planner = makePlanner({
      runPhase: vi.fn().mockRejectedValue(new Error('backend exploded')),
    });

    const { result, events } = await runSteps({ mode: 'standard', planner });

    expect(result).toMatchObject({ disposition: 'terminal', outcome: 'halted' });
    expect(events.some((event) => event.type === 'error')).toBe(true);
  });

  it('a hard constitution violation halts speckit at constitution-check', async () => {
    const project = setupProject('speckit');
    mkdirSync(join(project.projectDir, '.specify', 'memory'), { recursive: true });
    writeFileSync(
      join(project.projectDir, '.specify', 'memory', 'constitution.md'),
      '# Constitution\n\n- Ship one slice at a time.\n',
    );
    const { planner } = recordingPlanner({
      review: vi.fn().mockResolvedValue({
        text: '```json\n{"passed":false,"violations":[{"principle":"one-slice","reason":"too broad","severity":"hard"}]}\n```',
        usage: null,
      }),
    });

    const { result } = await runSteps({ mode: 'speckit', planner, project });

    expect(result).toMatchObject({ disposition: 'terminal', outcome: 'halted' });
    expect(result.state.phase).toBe('constitution-check');
  });
});

describe('runPlanningSteps — research ingress', () => {
  it('records the validation toolchain the research call discovered', async () => {
    const research = `### Validation Tools

- **Language**: typescript
- **Type checker**: \`npx tsc --noEmit\`
- **Linter**: \`npx biome check\`
- **Test runner**: \`./scripts/evil\`
- **Test file pattern**: \`*.test.ts\`

### Architecture
Some architecture.`;
    const { planner } = recordingPlanner({ texts: { research } });

    const { projectDir, sessionId, events } = await runSteps({ mode: 'standard', planner });

    const persisted = loadState({ projectDir, sessionId });
    expect(persisted?.discoveredValidation?.typecheckCommand).toBe('npx tsc --noEmit');
    expect(persisted?.discoveredValidation?.lintCommand).toBe('npx biome check');
    expect(persisted?.discoveredValidation?.testCommand).toBeUndefined();
    // The refusal is a run event, so the transcript shows it and session.jsonl keeps it.
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'warning',
        phase: 'researching',
        message: expect.stringMatching(/^The test stage .*\.\/scripts\/evil from the planner/),
      }),
    );
  });

  it('books the token usage of every call it made', async () => {
    const planner = makePlanner({
      runPhase: vi.fn(async ({ call }: RunPhaseInput) =>
        makePhaseCallResult({
          call,
          usage: { inputTokens: 10, outputTokens: 5 },
          ...(call === 'tasks' ? { tasks: [makeTask()] } : {}),
        }),
      ),
    });

    const { projectDir, sessionId } = await runSteps({ mode: 'standard', planner });

    const usage = loadState({ projectDir, sessionId })?.tokenUsage;
    expect(usage?.plannerInput).toBe(40);
    expect(usage?.plannerOutput).toBe(20);
  });
});
