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
import { ensureSessionDir, readSpecFile } from '../../../core/paths-io.js';
import { RESEARCH_FILE, TASKS_FILE } from '../../../core/paths.js';
import { createInitialState, transition } from '../../../core/state/machine.js';
import { loadState } from '../../../core/state/persistence.js';
import {
  createTaskCompilationAttemptId,
  OwnedPlannerArtifactSchema,
} from '../../../core/schemas/task-compilation.js';
import {
  type BriefRecoveryProjectionV1,
  BriefRecoveryProjectionV1Schema,
} from '../../../core/schemas/brief-recovery/document.js';
import type { StateAuthorityReceipt } from '../../../core/schemas/brief-recovery.js';
import { sha256Hex } from '../../../utils/sha256.js';
import type { PlanOptions, Planner, PlannerArtifactLogicalName } from '../../planners/types.js';
import type { ClarificationQuestion } from '../../../core/schemas/question.js';
import type { PhaseRecoveryBinding } from '../run/phases.js';
import { recoveryResultFromProjection } from './brief-review-gate.js';
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

function ownerRecoveryBinding(
  sessionId: string,
  projection: BriefRecoveryProjectionV1,
): PhaseRecoveryBinding {
  const result = recoveryResultFromProjection(projection);
  const controller: PhaseRecoveryBinding['controller'] = {
    inspectBriefRecovery: vi.fn(() => projection),
    enterBriefAdmission: vi.fn(async () => result),
    dispatchBriefAction: vi.fn(async () => result),
    queueBriefInput: vi.fn(async () => {
      throw new Error('queue not expected in compiler-failure parking');
    }),
    settlePlannerAttempt: vi.fn(async () => {
      throw new Error('settlement not expected in compiler-failure parking');
    }),
  };
  return {
    controller,
    authority: {
      kind: 'usable',
      sessionId,
      ownerId: 'owner-1',
      pid: 1,
      processStart: 'start-1',
      runId: 'run-1',
      acquisitionId: 'acquisition-1',
      fence: 1,
      stateRevision: 0,
      stateDigest: 'd'.repeat(64),
    } satisfies StateAuthorityReceipt,
    projection,
    admission: result,
    createAdmissionInput: () => {
      throw new Error('admission not expected in compiler-failure parking');
    },
    readState: () => {
      throw new Error('readState not expected in compiler-failure parking');
    },
    writeState: () => {},
  };
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

describe('runFullPlanning — compiler failure and task-brief projections', () => {
  it('parks a typed compiler failure with its code instead of terminating', async () => {
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

    expect(result.disposition).toBe('parked');
    if (result.disposition !== 'parked') return;
    expect(result.projection.blocker).toMatchObject({
      kind: 'provider',
      code: 'task_compiler_provider_failed',
    });
    expect(events.some((event) => event.type === 'warning')).toBe(true);
  });

  it('embeds the typed compiler code into the recovery projection blocker when parking', async () => {
    const projectDir = createTempDir('full-compiler-recovery');
    dirs.push(projectDir);
    const sessionId = 'sess-compiler-recovery';
    ensureSessionDir(projectDir, sessionId);
    const planner = makePlanner({
      plan: vi.fn().mockRejectedValue(
        Object.assign(new Error('Batch 1 ended with terminal status failed'), {
          kind: 'task_compiler_provider_failed',
          data: { status: 'failed', batchOrdinal: 0 },
        }),
      ),
    });
    const ownerProjection = BriefRecoveryProjectionV1Schema.parse({
      version: 1,
      sessionId,
      stateRevision: 1,
      recoveryRevision: 3,
      epochId: 'epoch-owner-1',
      status: 'checking',
      origin: { mode: 'speckit', entry: 'initial' },
      continuation: { version: 1, kind: 'speckit-analysis', entry: 'initial' },
      activeBrief: { revision: 2, hash: 'b'.repeat(64), path: 'tasks.md' },
      matchingReport: null,
      blocker: null,
      allowedActions: ['status'],
      activeOperation: null,
      latestAttempt: null,
      queuedInputs: { ids: [], count: 0, carriedCount: 0, heldCount: 0, releasedCount: 0 },
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
      recovery: ownerRecoveryBinding(sessionId, ownerProjection),
    });

    expect(result.disposition).toBe('parked');
    if (result.disposition !== 'parked') return;
    expect(result.projection.blocker).toMatchObject({
      kind: 'provider',
      code: 'task_compiler_provider_failed',
    });
    expect(result.projection.epochId).toBe('epoch-owner-1');
    expect(result.projection.recoveryRevision).toBe(3);
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

    expect(result.disposition).toBe('parked');
    expect(readSpecFile({ projectDir, sessionId }, RESEARCH_FILE)).toContain('# Research');
    expect(readSpecFile({ projectDir, sessionId }, TASKS_FILE)).toBeNull();
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
    expect(callbacks.callbacks.onApprovalNeeded).not.toHaveBeenCalled();
    expect(result.state.phase).toBe('reviewing-plan');
    expect(result.state.tasks).toHaveLength(1);
    expect(result.disposition).toBe('parked');
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
    expect(result.disposition).toBe('parked');
    expect(events.filter((event) => event.type === 'brief_quality_failed')).toHaveLength(0);
    expect(events.filter((event) => event.type === 'brief_quality_passed')).toHaveLength(0);
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
    });

    expect(planner.review).not.toHaveBeenCalled();
    expect(callbacks.callbacks.onApprovalNeeded).not.toHaveBeenCalled();
    expect(result.disposition).toBe('parked');
    expect(result.state.phase).toBe('reviewing-plan');
    expect(result.state.tasks).toEqual([]);
    expect(readSpecFile({ projectDir, sessionId }, TASKS_FILE)).toBeNull();
  });

  it('parks an invalid brief in reviewing-plan without opening brief review or erroring', async () => {
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
    expect(result.disposition).toBe('parked');
    expect(result.state.phase).toBe('reviewing-plan');
    expect(result.state.tasks).toHaveLength(1);
    expect(loadState({ projectDir, sessionId })?.phase).toBe('reviewing-plan');
    expect(loadState({ projectDir, sessionId })?.tasks).toHaveLength(1);
    expect(events.some((event) => event.type === 'error')).toBe(false);
  });
});
