import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it, expect, vi, afterAll, afterEach, beforeAll } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import {
  makeCallbacks,
  makePlanner,
  makeBusRecorder,
  TEST_METADATA,
  TEST_SINKS,
} from '#testing/helpers/orchestrator-factories.js';
import {
  REAL_TASKS_MD,
  makeBriefQualityFailureTask,
  makePassingTask,
} from '#testing/helpers/planning-phase.js';
import { ensureSessionDir, readSpecFile } from '../../../core/paths-io.js';
import { RESEARCH_FILE, TASKS_FILE } from '../../../core/paths.js';
import { createInitialState, transition } from '../../../core/state/machine.js';
import { loadState } from '../../../core/state/persistence.js';
import {
  createTaskCompilationAttemptId,
  OwnedPlannerArtifactSchema,
} from '../../../core/schemas/task-compilation.js';
import { sha256Hex } from '../../../utils/sha256.js';
import type { PlanOptions, Planner, PlannerArtifactLogicalName } from '../../planners/types.js';
import type { ClarificationQuestion } from '../../../core/schemas/question.js';
import { resolveValidationDisplayCommand } from '../validation/commands.js';
import { runFullPlanning } from './full.js';

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) cleanupTempDir(d);
  dirs = [];
});

async function writeProjectSkill(projectDir: string, id: string, name: string, body: string) {
  const dir = join(projectDir, '.claude', 'skills', id);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: a skill\n---\n${body}\n`,
  );
}

function phaseResult(logicalName: PlannerArtifactLogicalName, text: string) {
  const digest = sha256Hex(text);
  return {
    artifact: OwnedPlannerArtifactSchema.parse({
      semanticId: `full-test-${logicalName}`,
      programId: null,
      batchId: null,
      attemptId: createTaskCompilationAttemptId(),
      logicalName,
      transport: 'stdout-final',
      text,
      byteLength: Buffer.byteLength(text, 'utf8'),
      sha256: digest,
      runtimeReceipt: digest,
      terminal: {
        status: 'completed',
        recordId: `full-test-${logicalName}`,
        protocolDigest: digest,
      },
      sourceReceipt: { kind: 'stdout-final', resultDigest: digest },
    }),
  };
}

describe('runFullPlanning — skill rehydration', () => {
  // Discovery scans global roots under homedir(); a real HOME would pull the
  // developer's own ~/.claude/skills into these assertions.
  let fakeHome: string;
  let savedHome: string | undefined;

  beforeAll(() => {
    fakeHome = createTempDir('full-skill-home');
    savedHome = process.env.HOME;
    process.env.HOME = fakeHome;
  });

  afterAll(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    cleanupTempDir(fakeHome);
  });

  it('rebuilds skills context from persisted state ids when no live skills are supplied', async () => {
    const projectDir = createTempDir('full-skill-rehydrate');
    dirs.push(projectDir);
    const sessionId = 'sess-skill';
    ensureSessionDir(projectDir, sessionId);
    await writeProjectSkill(projectDir, 'auth-skill', 'AuthSkill', 'PERSISTED-SKILL-BODY');

    let captured: PlanOptions | undefined;
    const planner: Planner = makePlanner({
      plan: vi.fn(async (opts: PlanOptions) => {
        captured = opts;
        return {
          spec: '# Spec',
          plan: '# Plan',
          tasks: [makePassingTask()],
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      }),
    });

    const state = {
      ...transition(createInitialState('feat'), { type: 'START' }),
      selectedSkills: ['auth-skill'],
    };

    await runFullPlanning({
      wctx: {
        projectDir,
        sessionId,
        config: makeConfig({ workflow: { approve: 'none' } }),
        callbacks: makeCallbacks().callbacks,
        bus: makeBusRecorder().bus,
        metadata: TEST_METADATA,
        sinks: TEST_SINKS,
      },
      planner,
      state,
      feature: 'feat',
      selectedSkills: undefined,
      approveLevel: 'none',
    });

    expect(captured?.skillsContext).toContain('AuthSkill');
    expect(captured?.skillsContext).toContain('PERSISTED-SKILL-BODY');
  });

  it('omits skills context when neither live nor persisted skills exist', async () => {
    const projectDir = createTempDir('full-skill-none');
    dirs.push(projectDir);
    const sessionId = 'sess-skill-none';
    ensureSessionDir(projectDir, sessionId);

    let captured: PlanOptions | undefined;
    const planner: Planner = makePlanner({
      plan: vi.fn(async (opts: PlanOptions) => {
        captured = opts;
        return {
          spec: '# Spec',
          plan: '# Plan',
          tasks: [makePassingTask()],
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      }),
    });

    await runFullPlanning({
      wctx: {
        projectDir,
        sessionId,
        config: makeConfig({ workflow: { approve: 'none' } }),
        callbacks: makeCallbacks().callbacks,
        bus: makeBusRecorder().bus,
        metadata: TEST_METADATA,
        sinks: TEST_SINKS,
      },
      planner,
      state: transition(createInitialState('feat'), { type: 'START' }),
      feature: 'feat',
      selectedSkills: undefined,
      approveLevel: 'none',
    });

    expect(captured?.skillsContext).toBeUndefined();
  });
});

describe('runFullPlanning — questions', () => {
  it('non-conversational planner emitting markers → onQuestionAsked invoked', async () => {
    const projectDir = createTempDir('full-questions');
    dirs.push(projectDir);
    const sessionId = 'sess-questions';
    ensureSessionDir(projectDir, sessionId);

    const question: ClarificationQuestion = { id: 'q1', type: 'confirm', text: 'Proceed?' };
    const planner: Planner = makePlanner({
      plan: vi.fn(async (opts: PlanOptions) => {
        opts.callbacks.onQuestion?.([question]);
        return {
          spec: '# Spec',
          plan: '# Plan',
          tasks: [makePassingTask()],
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      }),
      review: vi
        .fn()
        .mockResolvedValueOnce({ text: '# Reviewed plan', usage: null })
        .mockResolvedValueOnce({ text: REAL_TASKS_MD, usage: null }),
    });
    expect(planner.capabilities.supportsConversationalPlanning).toBe(false);

    const onQuestionAsked = vi.fn().mockResolvedValue('skip');

    await runFullPlanning({
      wctx: {
        projectDir,
        sessionId,
        config: makeConfig({ workflow: { approve: 'none' } }),
        callbacks: makeCallbacks({ onQuestionAsked }).callbacks,
        bus: makeBusRecorder().bus,
        metadata: TEST_METADATA,
        sinks: TEST_SINKS,
      },
      planner,
      state: transition(createInitialState('feat'), { type: 'START' }),
      feature: 'feat',
      selectedSkills: undefined,
      approveLevel: 'none',
    });

    expect(onQuestionAsked).toHaveBeenCalledWith(question, 1, 1);
  });
});

describe('runFullPlanning — discovered validation ingress', () => {
  const researchWithDisallowedTest = `### Validation Tools

- **Language**: typescript
- **Type checker**: \`npx tsc --noEmit\`
- **Linter**: \`npx biome check\`
- **Test runner**: \`./scripts/evil\`
- **Test file pattern**: \`*.test.ts\`

### Architecture
Some architecture.`;

  it('a disallowed discovered testCommand never reaches persisted state / the handoff resolver sees only allowlisted commands', async () => {
    const projectDir = createTempDir('full-sanitize-ingress');
    dirs.push(projectDir);
    const sessionId = 'sess-sanitize';
    ensureSessionDir(projectDir, sessionId);

    const planner: Planner = makePlanner({
      plan: vi.fn().mockResolvedValue({
        spec: '# Spec',
        plan: '# Plan',
        tasks: [makePassingTask()],
        usage: { inputTokens: 1, outputTokens: 1 },
        phases: [phaseResult('research.md', researchWithDisallowedTest)],
      }),
    });

    const config = makeConfig({ workflow: { approve: 'none' } });

    await runFullPlanning({
      wctx: {
        projectDir,
        sessionId,
        config,
        callbacks: makeCallbacks().callbacks,
        bus: makeBusRecorder().bus,
        metadata: TEST_METADATA,
        sinks: TEST_SINKS,
      },
      planner,
      state: transition(createInitialState('feat'), { type: 'START' }),
      feature: 'feat',
      selectedSkills: undefined,
      approveLevel: 'none',
    });

    const persisted = loadState({ projectDir, sessionId });
    expect(persisted?.discoveredValidation).toBeDefined();
    expect(persisted?.discoveredValidation?.testCommand).toBeUndefined();
    expect(persisted?.discoveredValidation?.lintCommand).toBe('npx biome check');
    expect(persisted?.discoveredValidation?.typecheckCommand).toBe('npx tsc --noEmit');

    const handoffTest = resolveValidationDisplayCommand(
      'testCommand',
      config,
      persisted?.discoveredValidation,
      projectDir,
    );
    expect(handoffTest).not.toBe('./scripts/evil');
    if (handoffTest) {
      expect(handoffTest).not.toMatch(/^\.\//);
      expect(handoffTest).not.toMatch(/^\//);
    }
  });
});

describe('runFullPlanning — compiler failures and task-brief projections', () => {
  it('fails planning terminally on a typed compiler failure', async () => {
    const projectDir = createTempDir('full-compiler-failure');
    dirs.push(projectDir);
    const sessionId = 'sess-compiler-failure';
    ensureSessionDir(projectDir, sessionId);
    const { bus, events } = makeBusRecorder();
    const planner = makePlanner({
      plan: vi.fn().mockRejectedValue(
        Object.assign(new Error('Batch 1 ended with terminal status failed'), {
          kind: 'task_compiler_provider_failed',
          data: { status: 'failed', batchOrdinal: 0 },
        }),
      ),
    });

    const result = await runFullPlanning({
      wctx: {
        projectDir,
        sessionId,
        config: makeConfig({ workflow: { approve: 'none' } }),
        callbacks: makeCallbacks().callbacks,
        bus,
        metadata: TEST_METADATA,
        sinks: TEST_SINKS,
      },
      planner,
      state: transition(createInitialState('feat'), { type: 'START' }),
      feature: 'feat',
      approveLevel: 'none',
    });

    expect(result).toMatchObject({ disposition: 'terminal', outcome: 'failed' });
    expect(events.some((event) => event.type === 'error')).toBe(true);
  });

  it('keeps task-brief phases out of the pre-commit compatibility projection', async () => {
    const projectDir = createTempDir('full-phases-filter');
    dirs.push(projectDir);
    const sessionId = 'sess-phases-filter';
    ensureSessionDir(projectDir, sessionId);
    const planner = makePlanner({
      plan: vi.fn().mockResolvedValue({
        spec: '# Spec',
        plan: '# Plan',
        tasks: [makePassingTask()],
        usage: { inputTokens: 1, outputTokens: 1 },
        phases: [
          phaseResult('research.md', '# Research'),
          phaseResult('spec.md', '# Spec'),
          phaseResult('plan.md', '# Plan'),
          phaseResult('tasks.md', REAL_TASKS_MD),
        ],
      }),
    });

    const result = await runFullPlanning({
      wctx: {
        projectDir,
        sessionId,
        config: makeConfig({ workflow: { approve: 'none' } }),
        callbacks: makeCallbacks().callbacks,
        bus: makeBusRecorder().bus,
        metadata: TEST_METADATA,
        sinks: TEST_SINKS,
      },
      planner,
      state: transition(createInitialState('feat'), { type: 'START' }),
      feature: 'feat',
      approveLevel: 'none',
    });

    expect(result.disposition).toBe('tasks-ready');
    expect(readSpecFile({ projectDir, sessionId }, RESEARCH_FILE)).toContain('# Research');
    expect(readSpecFile({ projectDir, sessionId }, TASKS_FILE)).toBeNull();
  });
});

describe('runFullPlanning — brief quality stays with the phase runner', () => {
  it('does not regenerate a passing Task Brief set before brief review', async () => {
    const projectDir = createTempDir('full-quality-pass');
    dirs.push(projectDir);
    const sessionId = 'sess-quality-pass';
    ensureSessionDir(projectDir, sessionId);
    const callbacks = makeCallbacks();
    const { bus, events } = makeBusRecorder();
    const planner = makePlanner({
      plan: vi.fn().mockResolvedValue({
        spec: '# Spec',
        plan: '# Plan',
        tasks: [makePassingTask()],
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    });

    const result = await runFullPlanning({
      wctx: {
        projectDir,
        sessionId,
        config: makeConfig({ workflow: { approve: 'none' } }),
        callbacks: callbacks.callbacks,
        bus,
        metadata: TEST_METADATA,
        sinks: TEST_SINKS,
      },
      planner,
      state: transition(createInitialState('feat'), { type: 'START' }),
      feature: 'feat',
      approveLevel: 'none',
    });

    expect(planner.review).not.toHaveBeenCalled();
    expect(callbacks.callbacks.onApprovalNeeded).not.toHaveBeenCalled();
    expect(result.state.phase).toBe('reviewing-plan');
    expect(result.state.tasks).toHaveLength(1);
    expect(result.disposition).toBe('tasks-ready');
    expect(events.filter((event) => event.type === 'brief_quality_passed')).toHaveLength(0);
  });

  it('does not repair an initial zero-task result before brief review', async () => {
    const projectDir = createTempDir('full-quality-repair');
    dirs.push(projectDir);
    const sessionId = 'sess-quality-repair';
    ensureSessionDir(projectDir, sessionId);
    const callbacks = makeCallbacks();
    const { bus, events } = makeBusRecorder();
    const planner = makePlanner({
      plan: vi.fn().mockResolvedValue({
        spec: '# Spec',
        plan: '# Plan',
        tasks: [],
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    });

    const result = await runFullPlanning({
      wctx: {
        projectDir,
        sessionId,
        config: makeConfig({ workflow: { approve: 'none' } }),
        callbacks: callbacks.callbacks,
        bus,
        metadata: TEST_METADATA,
        sinks: TEST_SINKS,
      },
      planner,
      state: transition(createInitialState('feat'), { type: 'START' }),
      feature: 'feat',
      approveLevel: 'none',
    });

    expect(planner.plan).toHaveBeenCalledTimes(1);
    expect(planner.review).not.toHaveBeenCalled();
    expect(callbacks.callbacks.onApprovalNeeded).not.toHaveBeenCalled();
    expect(result.state.phase).toBe('reviewing-plan');
    expect(result.state.tasks).toEqual([]);
    expect(result.disposition).toBe('tasks-ready');
    expect(events.filter((event) => event.type === 'brief_quality_failed')).toHaveLength(0);
    expect(events.filter((event) => event.type === 'brief_quality_passed')).toHaveLength(0);
  });

  it('returns an invalid brief from reviewing-plan without opening brief review or erroring', async () => {
    const projectDir = createTempDir('full-quality-failure');
    dirs.push(projectDir);
    const sessionId = 'sess-quality-failure';
    ensureSessionDir(projectDir, sessionId);
    const callbacks = makeCallbacks();
    const { bus, events } = makeBusRecorder();
    const invalidTask = makeBriefQualityFailureTask();
    const planner = makePlanner({
      plan: vi.fn().mockResolvedValue({
        spec: '# Spec',
        plan: '# Plan',
        tasks: [invalidTask],
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    });

    const result = await runFullPlanning({
      wctx: {
        projectDir,
        sessionId,
        config: makeConfig({ workflow: { approve: 'none' } }),
        callbacks: callbacks.callbacks,
        bus,
        metadata: TEST_METADATA,
        sinks: TEST_SINKS,
      },
      planner,
      state: transition(createInitialState('feat'), { type: 'START' }),
      feature: 'feat',
      approveLevel: 'none',
    });

    expect(planner.review).not.toHaveBeenCalled();
    expect(callbacks.callbacks.onApprovalNeeded).not.toHaveBeenCalled();
    expect(result.disposition).toBe('tasks-ready');
    expect(result.state.phase).toBe('reviewing-plan');
    expect(result.state.tasks).toHaveLength(1);
    expect(loadState({ projectDir, sessionId })?.phase).toBe('reviewing-plan');
    expect(loadState({ projectDir, sessionId })?.tasks).toHaveLength(1);
    expect(events.some((event) => event.type === 'error')).toBe(false);
  });
});

describe('runFullPlanning — producer disposition', () => {
  it('full planning returns tasks-ready with parsed tasks', async () => {
    const projectDir = createTempDir('full-tasks-ready');
    dirs.push(projectDir);
    const sessionId = 'sess-tasks-ready';
    ensureSessionDir(projectDir, sessionId);
    const task = makePassingTask();
    const planner = makePlanner({
      plan: vi.fn().mockResolvedValue({
        spec: '# Spec',
        plan: '# Plan',
        tasks: [task],
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    });

    const result = await runFullPlanning({
      wctx: {
        projectDir,
        sessionId,
        config: makeConfig({ workflow: { approve: 'none' } }),
        callbacks: makeCallbacks().callbacks,
        bus: makeBusRecorder().bus,
        metadata: TEST_METADATA,
        sinks: TEST_SINKS,
      },
      planner,
      state: transition(createInitialState('feat'), { type: 'START' }),
      feature: 'feat',
      approveLevel: 'none',
    });

    expect(result.disposition).toBe('tasks-ready');
    if (result.disposition !== 'tasks-ready') return;
    expect(result.tasks).toEqual([task]);
  });
});
