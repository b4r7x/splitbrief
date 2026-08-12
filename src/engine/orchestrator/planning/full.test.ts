import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it, expect, vi, afterEach } from 'vitest';
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
import { ensureSessionDir } from '../../../core/paths-io.js';
import { createInitialState, transition } from '../../../core/state/machine.js';
import { loadState } from '../../../core/state/persistence.js';
import type { PlanOptions, Planner } from '../../planners/types.js';
import type { ClarificationQuestion } from '../../../core/schemas/question.js';
import { resolveValidationDisplayCommand } from '../validation/commands.js';
import { formatTasks } from '../../spec/formatter.js';
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

describe('runFullPlanning — skill rehydration', () => {
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
      deferBriefGate: true,
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
      deferBriefGate: true,
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
      deferBriefGate: true,
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
        phases: [{ filename: 'research.md', text: researchWithDisallowedTest }],
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
      deferBriefGate: true,
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

describe('runFullPlanning — brief quality preparation', () => {
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
    expect(callbacks.callbacks.onApprovalNeeded).toHaveBeenCalledTimes(1);
    expect(result.state.phase).toBe('implementing');
    expect(result.tasks).toHaveLength(1);
    expect(result.failed).toBe(false);
    expect(events.filter((event) => event.type === 'brief_quality_passed')).toHaveLength(1);
  });

  it('repairs an initial zero-task result once before entering brief review', async () => {
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
      review: vi.fn().mockResolvedValue({ text: REAL_TASKS_MD, usage: null }),
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
    expect(planner.review).toHaveBeenCalledTimes(1);
    expect(callbacks.callbacks.onApprovalNeeded).toHaveBeenCalledTimes(1);
    expect(result.state.phase).toBe('implementing');
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]?.id).toBe('T001');
    expect(result.failed).toBe(false);
    expect(events.filter((event) => event.type === 'brief_quality_failed')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'brief_quality_passed')).toHaveLength(1);
  });

  it('prepares deferred briefs once without opening review', async () => {
    const projectDir = createTempDir('full-quality-deferred');
    dirs.push(projectDir);
    const sessionId = 'sess-quality-deferred';
    ensureSessionDir(projectDir, sessionId);
    const callbacks = makeCallbacks();
    const planner = makePlanner({
      plan: vi.fn().mockResolvedValue({
        spec: '# Spec',
        plan: '# Plan',
        tasks: [],
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
      review: vi.fn().mockResolvedValue({ text: REAL_TASKS_MD, usage: null }),
    });

    const result = await runFullPlanning({
      wctx: {
        projectDir,
        sessionId,
        config: makeConfig({ workflow: { approve: 'none' } }),
        callbacks: callbacks.callbacks,
        bus: makeBusRecorder().bus,
        metadata: TEST_METADATA,
        sinks: TEST_SINKS,
      },
      planner,
      state: transition(createInitialState('feat'), { type: 'START' }),
      feature: 'feat',
      approveLevel: 'none',
      deferBriefGate: true,
    });

    expect(planner.review).toHaveBeenCalledTimes(1);
    expect(callbacks.callbacks.onApprovalNeeded).not.toHaveBeenCalled();
    expect(result.cancelled).toBe(false);
    expect(result.failed).toBe(false);
    expect(result.state.phase).toBe('reviewing-plan');
    expect(result.tasks).toHaveLength(1);
  });

  it('cancels after a second quality failure without opening brief review', async () => {
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
      review: vi.fn().mockResolvedValue({ text: formatTasks([invalidTask]), usage: null }),
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

    expect(planner.review).toHaveBeenCalledTimes(1);
    expect(callbacks.callbacks.onApprovalNeeded).not.toHaveBeenCalled();
    expect(result.cancelled).toBe(true);
    expect(result.failed).toBe(true);
    expect(result.state.phase).toBe('idle');
    expect(result.tasks).toEqual([]);
    expect(loadState({ projectDir, sessionId })?.phase).toBe('idle');
    expect(loadState({ projectDir, sessionId })?.tasks).toEqual([]);
    expect(events.some((event) => event.type === 'error')).toBe(true);
  });
});
