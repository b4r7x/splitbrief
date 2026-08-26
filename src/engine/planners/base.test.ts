import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createPlannerBase,
  installCompilerRefusal,
  installCompilerSeam,
  readPlannerCompilerDispatch,
  readPlannerCompilerRefusal,
  readPlannerCompilerSeam,
  type CompilerSeam,
} from './base.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeRunnerCallResult } from '#testing/helpers/factories/runner-call.js';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SESSION_LOG_FILE, sessionDir } from '../../core/paths.js';
import {
  createTaskCompilationAttemptId,
  TASK_BRIEF_COMPILER_POLICY,
  TaskCompilationBatchIdSchema,
  TaskCompilationOperationIdSchema,
  TaskCompilationProgramIdSchema,
  type TaskCompilationCallEnvelope,
  type PlannerSessionScope,
} from '../../core/schemas/task-compilation.js';
import { createTaskDispatchClaimPort, createTaskDispatchLedger } from '../calls/dispatch-ledger.js';
import type { PreparedPlannerInvocation } from '../runners/types.js';
import type { PlannerCapabilities } from './types.js';
import type { RunnerCallEvent } from '../calls/types.js';

let projectDir: string;

const minimalTask = makeTask();

const defaultCapabilities: PlannerCapabilities = {
  supportsConversationalPlanning: false,
  supportsHintEscalation: true,
  supportsSessionResume: false,
  supportsEffort: false,
  supportsImages: false,
  supportsSelfSummarisation: false,
};

const taskMarkdown = `---
id: T001
title: Test task
action: create
file: src/example.py
depends_on: []
---

### Description
Create an example file.

### Implementation Steps
1. Write the file.

### Tests
- pytest passes

### Constraints
- Follow project conventions
`;

function readSessionLog(projectDir: string, sessionId: string): unknown[] {
  const logPath = join(sessionDir(projectDir, sessionId), SESSION_LOG_FILE);
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, 'utf-8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

function completedRunnerCall(text: string) {
  return makeRunnerCallResult({ status: 'completed', text });
}

beforeEach(() => {
  projectDir = createTempDir('planner-base-test');
  createTestGitRepo(projectDir);
});

afterEach(() => {
  cleanupTempDir(projectDir);
});

describe('createPlannerBase — phase artifact content', () => {
  it('phases[].artifact.text is the completed terminal result text', async () => {
    const planner = createPlannerBase({
      invokePlan: async () => completedRunnerCall('# Resolved artifact content'),
      invokeEscalate: async () => completedRunnerCall(''),
      isAvailable: async () => true,
      capabilities: defaultCapabilities,
    });

    const result = await planner.plan({
      feature: 'feature',
      projectDir,
      callbacks: { onOutput: () => {} },
    });
    expect(result.phases).toHaveLength(4);
    for (const phase of result.phases ?? []) {
      expect(phase.artifact.text).toBe('# Resolved artifact content');
      expect(phase.rawOutput).toBeUndefined();
    }
  });

  it('quickPlan phases[].artifact.text is the terminal result text', async () => {
    const planner = createPlannerBase({
      invokePlan: async () =>
        completedRunnerCall(`---
id: T001
title: Test task
action: create
file: test.ts
---

### Description
A test task.

### Tests
- pass

### Constraints
- none
`),
      invokeEscalate: async () => completedRunnerCall(''),
      isAvailable: async () => true,
      capabilities: defaultCapabilities,
    });

    const result = await planner.quickPlan({
      feature: 'feature',
      projectDir,
      callbacks: { onOutput: () => {} },
    });
    expect(result.phases).toHaveLength(1);
    expect(result.phases![0]!.artifact.text).toContain('id: T001');
    expect(result.phases![0]!.rawOutput).toBeUndefined();
  });

  it('standard planning uses research-discovered language for later prompts', async () => {
    const captured: string[] = [];
    const outputs = [
      `## Validation Tools

- **Language**: python
- **Type checker**: \`mypy src/\`
- **Linter**: \`ruff check\`
- **Test runner**: \`pytest\`
- **Test file pattern**: \`test_*.py\``,
      '# Spec',
      '# Plan',
      taskMarkdown,
    ];
    const planner = createPlannerBase({
      invokePlan: async ({ prompt }) => {
        captured.push(prompt);
        return completedRunnerCall(outputs[captured.length - 1] ?? '');
      },
      invokeEscalate: async () => completedRunnerCall(''),
      isAvailable: async () => true,
      capabilities: defaultCapabilities,
    });

    await planner.plan({ feature: 'feature', projectDir, callbacks: { onOutput: () => {} } });

    expect(captured[2]).toContain('Python');
    expect(captured[2]).toContain('PEP 484');
    expect(captured[2]).not.toContain('TypeScript');
    expect(captured[3]).toContain('file: src/path/to/file.py');
    expect(captured[3]).not.toContain('```typescript');
  });

  it('quickPlan uses prompt-language heuristic when no research phase exists', async () => {
    writeFileSync(join(projectDir, 'pyproject.toml'), '[tool.pytest.ini_options]');
    let captured = '';
    const planner = createPlannerBase({
      invokePlan: async ({ prompt }) => {
        captured = prompt;
        return completedRunnerCall(taskMarkdown);
      },
      invokeEscalate: async () => completedRunnerCall(''),
      isAvailable: async () => true,
      capabilities: defaultCapabilities,
    });

    await planner.quickPlan({ feature: 'feature', projectDir, callbacks: { onOutput: () => {} } });

    expect(captured).toContain('Python');
    expect(captured).toContain('file: src/path/to/file.py');
    expect(captured).not.toMatch(/TypeScript|```typescript|file\.ts/);
  });

  it('flushes interrupted buffered output when a standard planner phase aborts', async () => {
    const controller = new AbortController();
    const sessionId = 'sess-planner-base-abort';
    const err = new Error('aborted');
    const planner = createPlannerBase({
      invokePlan: async ({ callbacks }) => {
        callbacks.onOutput('partial research output');
        controller.abort();
        throw err;
      },
      invokeEscalate: async () => completedRunnerCall(''),
      isAvailable: async () => true,
      capabilities: defaultCapabilities,
    });

    await expect(
      planner.plan({
        feature: 'feature',
        projectDir,
        callbacks: {
          onOutput: () => {},
          persistTranscript: true,
          sessionId,
          signal: controller.signal,
        },
      }),
    ).rejects.toBe(err);

    expect(readSessionLog(projectDir, sessionId)).toEqual([
      expect.objectContaining({
        kind: 'message',
        role: 'assistant',
        phase: 'researching',
        text: 'partial research output',
        interrupted: true,
      }),
    ]);
  });
});

describe('createPlannerBase — hintSuccessMode', () => {
  it('hintSuccessMode: "files" — succeeds when files are written', async () => {
    const outFile = join(projectDir, 'hint-out.ts');
    const planner = createPlannerBase({
      invokePlan: async () => completedRunnerCall(''),
      invokeEscalate: async () => {
        writeFileSync(outFile, '// written by escalation');
        return completedRunnerCall('');
      },
      isAvailable: async () => true,
      capabilities: defaultCapabilities,
      hintSuccessMode: 'files',
    });

    const result = await planner.escalateHint({
      task: minimalTask,
      error: 'error',
      projectDir,
      callbacks: { onOutput: () => {} },
    });
    expect(result.success).toBe(true);
  });

  it('hintSuccessMode: "files" — fails when no files are written', async () => {
    const planner = createPlannerBase({
      invokePlan: async () => completedRunnerCall(''),
      invokeEscalate: async () => completedRunnerCall(''),
      isAvailable: async () => true,
      capabilities: defaultCapabilities,
      hintSuccessMode: 'files',
    });

    const result = await planner.escalateHint({
      task: minimalTask,
      error: 'error',
      projectDir,
      callbacks: { onOutput: () => {} },
    });
    expect(result.success).toBe(false);
  });

  it('hintSuccessMode: "text" (default) — succeeds when text is non-empty', async () => {
    const planner = createPlannerBase({
      invokePlan: async () => completedRunnerCall(''),
      invokeEscalate: async () => completedRunnerCall('some hint output'),
      isAvailable: async () => true,
      capabilities: defaultCapabilities,
    });

    const result = await planner.escalateHint({
      task: minimalTask,
      error: 'error',
      projectDir,
      callbacks: { onOutput: () => {} },
    });
    expect(result.success).toBe(true);
  });

  it('hintSuccessMode: "text" (default) — fails when text is empty', async () => {
    const planner = createPlannerBase({
      invokePlan: async () => completedRunnerCall(''),
      invokeEscalate: async () => completedRunnerCall(''),
      isAvailable: async () => true,
      capabilities: defaultCapabilities,
    });

    const result = await planner.escalateHint({
      task: minimalTask,
      error: 'error',
      projectDir,
      callbacks: { onOutput: () => {} },
    });
    expect(result.success).toBe(false);
  });

  it('capabilities.supportsHintEscalation: false — always returns success: false', async () => {
    const planner = createPlannerBase({
      invokePlan: async () => completedRunnerCall(''),
      invokeEscalate: async () => completedRunnerCall('lots of output'),
      isAvailable: async () => true,
      capabilities: {
        supportsConversationalPlanning: false,
        supportsHintEscalation: false,
        supportsSessionResume: false,
        supportsEffort: false,
        supportsImages: false,
        supportsSelfSummarisation: false,
      },
    });

    const result = await planner.escalateHint({
      task: minimalTask,
      error: 'error',
      projectDir,
      callbacks: { onOutput: () => {} },
    });
    expect(result.success).toBe(false);
  });

  it('hintSuccessMode: "files" — ignores pre-existing dirty files (before/after snapshot)', async () => {
    const preExisting = join(projectDir, 'pre-existing.ts');
    writeFileSync(preExisting, '// dirty before escalation');

    const newFile = join(projectDir, 'new-from-hint.ts');
    const planner = createPlannerBase({
      invokePlan: async () => completedRunnerCall(''),
      invokeEscalate: async () => {
        writeFileSync(newFile, '// written by hint');
        return completedRunnerCall('');
      },
      isAvailable: async () => true,
      capabilities: defaultCapabilities,
      hintSuccessMode: 'files',
    });

    const result = await planner.escalateHint({
      task: minimalTask,
      error: 'error',
      projectDir,
      callbacks: { onOutput: () => {} },
    });
    // The new file is what triggered success — pre-existing dirty file is baseline, not a signal
    expect(result.success).toBe(true);
  });

  it('hintSuccessMode: "files" — not success when only pre-existing dirty files remain', async () => {
    const preExisting = join(projectDir, 'pre-existing-only.ts');
    writeFileSync(preExisting, '// dirty before escalation');

    const planner = createPlannerBase({
      invokePlan: async () => completedRunnerCall(''),
      invokeEscalate: async () => completedRunnerCall(''),
      isAvailable: async () => true,
      capabilities: defaultCapabilities,
      hintSuccessMode: 'files',
    });

    const result = await planner.escalateHint({
      task: minimalTask,
      error: 'error',
      projectDir,
      callbacks: { onOutput: () => {} },
    });
    expect(result.success).toBe(false);
  });
});

describe('createPlannerBase — structured summarization', () => {
  it('validates structured summary JSON from the planner', async () => {
    const structured = {
      goal: 'add compaction',
      stepsCompleted: ['wrote schema'],
      currentStep: 'testing',
      filesModified: ['src/core/schemas/compaction.ts'],
      constraintsDiscovered: ['return JSON only'],
      remainingWork: ['run tests'],
    };
    const planner = createPlannerBase({
      invokePlan: async () => completedRunnerCall(''),
      invokeEscalate: async () => completedRunnerCall(JSON.stringify(structured)),
      isAvailable: async () => true,
      capabilities: defaultCapabilities,
    });

    const result = await planner.summarizeStructured?.([{ role: 'user', text: 'compact this' }], {
      projectDir,
    });

    expect(result).toEqual({ text: JSON.stringify(structured), structured, usage: null });
  });

  it('uses the merge prompt when a previous structured summary is provided', async () => {
    const previous = {
      goal: 'add compaction',
      stepsCompleted: ['old step'],
      currentStep: 'old current',
      filesModified: ['old.ts'],
      constraintsDiscovered: ['old constraint'],
      remainingWork: ['old work'],
    };
    let prompt = '';
    const planner = createPlannerBase({
      invokePlan: async () => completedRunnerCall(''),
      invokeEscalate: async (opts) => {
        prompt = opts.prompt;
        return completedRunnerCall(JSON.stringify(previous));
      },
      isAvailable: async () => true,
      capabilities: defaultCapabilities,
    });

    await planner.summarizeStructured?.([{ role: 'assistant', text: 'new work' }], {
      previousSummary: previous,
      projectDir,
    });

    expect(prompt).toContain('Previous summary:');
    expect(prompt).toContain(JSON.stringify(previous));
    expect(prompt).toContain('New messages:');
  });

  it('passes signal and runner-call callbacks to structured summary invocations', async () => {
    const controller = new AbortController();
    const events: RunnerCallEvent[] = [];
    const structured = {
      goal: 'add compaction',
      stepsCompleted: ['old step'],
      currentStep: 'testing',
      filesModified: ['src/core/schemas/compaction.ts'],
      constraintsDiscovered: ['return JSON only'],
      remainingWork: ['run tests'],
    };
    let capturedSignal: AbortSignal | undefined;
    const planner = createPlannerBase({
      invokePlan: async () => completedRunnerCall(''),
      invokeEscalate: async (opts) => {
        capturedSignal = opts.signal;
        opts.callbacks.onCallEvent?.({ type: 'call_started', ts: Date.now(), ...opts.callContext });
        return completedRunnerCall(JSON.stringify(structured));
      },
      isAvailable: async () => true,
      capabilities: defaultCapabilities,
    });

    await planner.summarizeStructured?.([{ role: 'user', text: 'compact this' }], {
      projectDir,
      signal: controller.signal,
      callbacks: { onCallEvent: (event) => events.push(event) },
      role: 'compaction',
    });

    expect(capturedSignal).toBe(controller.signal);
    expect(events[0]).toMatchObject({
      type: 'call_started',
      role: 'compaction',
      backendKind: 'cli',
    });
  });
});

describe('createPlannerBase — priorMessages injection (FR-007)', () => {
  it('prepends a <!-- prior conversation --> block to the first phase prompt for CLI-style backends', async () => {
    const captured: string[] = [];
    const planner = createPlannerBase({
      invokePlan: async ({ prompt }) => {
        captured.push(prompt);
        return completedRunnerCall(taskMarkdown);
      },
      invokeEscalate: async () => completedRunnerCall(''),
      isAvailable: async () => true,
      capabilities: defaultCapabilities,
    });

    await planner.plan({
      feature: 'feature',
      projectDir,
      callbacks: {
        onOutput: () => {},
        priorMessages: [
          { role: 'user', content: 'first turn' },
          { role: 'assistant', content: 'first answer' },
        ],
      },
    });

    // First phase (research) gets the prefix
    expect(captured[0]).toContain('<!-- prior conversation -->');
    expect(captured[0]).toContain('[user] first turn');
    expect(captured[0]).toContain('[assistant] first answer');
    expect(captured[0]).toContain('<!-- /prior conversation -->');
    // Subsequent phases do NOT repeat the prefix
    expect(captured[1]).not.toContain('<!-- prior conversation -->');
    expect(captured[2]).not.toContain('<!-- prior conversation -->');
    expect(captured[3]).not.toContain('<!-- prior conversation -->');
  });

  it('does NOT prepend CLI prefix when consumesPriorMessages is true', async () => {
    let seenPriorMessages: ReadonlyArray<{ role: string; content: string }> | undefined;
    const captured: string[] = [];
    const planner = createPlannerBase({
      invokePlan: async ({ prompt, priorMessages }) => {
        captured.push(prompt);
        if (priorMessages) seenPriorMessages = priorMessages;
        return completedRunnerCall(taskMarkdown);
      },
      invokeEscalate: async () => completedRunnerCall(''),
      isAvailable: async () => true,
      capabilities: defaultCapabilities,
      consumesPriorMessages: true,
    });

    await planner.plan({
      feature: 'feature',
      projectDir,
      callbacks: {
        onOutput: () => {},
        priorMessages: [{ role: 'user', content: 'raw turn' }],
      },
    });

    expect(captured[0]).not.toContain('<!-- prior conversation -->');
    expect(seenPriorMessages).toEqual([{ role: 'user', content: 'raw turn' }]);
  });
});

function compilerEnvelopeFixture(): TaskCompilationCallEnvelope {
  return {
    version: 1,
    promptBytes: TASK_BRIEF_COMPILER_POLICY.maxPromptBytes,
    inputTokensUpperBound: TASK_BRIEF_COMPILER_POLICY.maxPromptBytes,
    requestedOutputTokens: TASK_BRIEF_COMPILER_POLICY.requestedOutputTokens,
    outputTokensUpperBound: TASK_BRIEF_COMPILER_POLICY.maxNormalizedOutputBytes,
    maxNormalizedOutputBytes: TASK_BRIEF_COMPILER_POLICY.maxNormalizedOutputBytes,
    maxDeclaredArtifactBytes: TASK_BRIEF_COMPILER_POLICY.maxDeclaredArtifactBytes,
    maxRawProtocolBytes: TASK_BRIEF_COMPILER_POLICY.maxRawProtocolBytes,
    maxStderrBytes: TASK_BRIEF_COMPILER_POLICY.maxStderrBytes,
    deadlineMs: TASK_BRIEF_COMPILER_POLICY.deadlineMs,
    idleTimeoutMs: TASK_BRIEF_COMPILER_POLICY.idleTimeoutMs,
  };
}

function compilerInvocationFixture(): PreparedPlannerInvocation {
  return {
    runtime: {
      executablePath: '/usr/bin/fake-compiler',
      version: 'fixture-1.0.0',
      runtimeDigest: 'runtime-fixture-digest',
      protocolDigest: 'protocol-fixture-digest',
    },
    role: 'planner-read-only',
    transport: { kind: 'stdout-final' },
    terminalContract: 'fixture-terminal',
    envelope: compilerEnvelopeFixture(),
    capabilityDigest: 'capability-fixture-digest',
  };
}

function compilerReceiptFixture(): NonNullable<CompilerSeam['receipt']> {
  return {
    backend: 'claude-code',
    version: '2.1.232',
    runtimeVersion: '2.1.232',
    versionObservation: 'tested',
    role: 'planner-read-only',
    transport: 'stdout-final',
    terminalContract: 'claude-terminal-result-v1',
    containmentProfile: 'seatbelt',
    credentialChannel: 'session-copy',
    envelopeVersion: 1,
    fixtureDate: '2026-08-15',
    capabilityDigest: '0000000000000000000000000000000000000000000000000000000000000000',
  };
}

function compilerLedgerFixture(operationId: string) {
  return createTaskDispatchLedger({
    operation: {
      version: 1,
      dispatchLimit: 64,
      callCount: 0,
      totalPromptBytes: 0,
      totalInputTokensUpperBound: 0,
      totalOutputTokensUpperBound: 0,
      totalNormalizedOutputBytes: 0,
      totalDeclaredArtifactBytes: 0,
      callsDigest: 'digest',
    },
    operationId: TaskCompilationOperationIdSchema.parse(operationId),
    claimPort: createTaskDispatchClaimPort(),
  });
}

describe('createPlannerBase — compiler batch dispatch', () => {
  it('registers a compiler batch dispatch that invokes plan with envelope constraints and call context', async () => {
    let invokedWith: unknown = null;
    const planner = createPlannerBase({
      invokePlan: async (opts) => {
        invokedWith = opts;
        return completedRunnerCall(taskMarkdown);
      },
      invokeEscalate: async () => completedRunnerCall(''),
      isAvailable: async () => true,
      capabilities: defaultCapabilities,
      backendKind: 'cli',
      runnerName: 'claude-code',
      model: 'claude-3-7-sonnet',
    });

    const dispatch = readPlannerCompilerDispatch(planner);
    expect(dispatch).toBeTypeOf('function');

    const operationId = TaskCompilationOperationIdSchema.parse('op-test-dispatch');
    const programId = TaskCompilationProgramIdSchema.parse('prog-1');
    const batchId1 = TaskCompilationBatchIdSchema.parse('batch-1');
    const envelope = compilerEnvelopeFixture();
    const ledger = createTaskDispatchLedger({
      operation: {
        version: 1,
        dispatchLimit: 1,
        callCount: 0,
        totalPromptBytes: 0,
        totalInputTokensUpperBound: 0,
        totalOutputTokensUpperBound: 0,
        totalNormalizedOutputBytes: 0,
        totalDeclaredArtifactBytes: 0,
        callsDigest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
      },
      operationId,
      claimPort: createTaskDispatchClaimPort(),
    });

    installCompilerSeam(planner, {
      invocation: compilerInvocationFixture(),
      ledger,
      dispatch: dispatch!,
      receipt: compilerReceiptFixture(),
    });

    const attemptId1 = createTaskCompilationAttemptId();
    const sessionScope: PlannerSessionScope = {
      kind: 'detached-fresh',
      operationId,
      programId,
      batchId: batchId1,
      attemptId: attemptId1,
    };

    const result1 = await dispatch!({
      attemptId: attemptId1,
      batch: {
        batchId: batchId1,
        prompt: 'compile batch 1',
        envelope,
      },
      sessionScope,
      projectDir: '/custom/project/dir',
    });

    expect(result1.status).toBe('completed');
    expect(result1.text).toBe(taskMarkdown);
    expect(invokedWith).toMatchObject({
      prompt: 'compile batch 1',
      projectDir: '/custom/project/dir',
      artifactFile: 'tasks.md',
      callContext: {
        callId: attemptId1,
        attemptId: attemptId1,
        role: 'planner',
        backendKind: 'cli',
        runnerName: 'claude-code',
        model: 'claude-3-7-sonnet',
        transport: { kind: 'stdout-final' },
        sessionScope,
        envelope,
      },
    });
  });

  it('recovery dispatch reaches the planner invoke path after a prior aggregate claim', async () => {
    let invokeCallCount = 0;
    const planner = createPlannerBase({
      invokePlan: async () => {
        invokeCallCount += 1;
        return completedRunnerCall(taskMarkdown);
      },
      invokeEscalate: async () => completedRunnerCall(''),
      isAvailable: async () => true,
      capabilities: defaultCapabilities,
    });

    const dispatch = readPlannerCompilerDispatch(planner);
    const operationId = TaskCompilationOperationIdSchema.parse('op-recovery-dispatch');
    const ledger = compilerLedgerFixture('op-recovery-dispatch');

    installCompilerSeam(planner, {
      invocation: compilerInvocationFixture(),
      ledger,
      dispatch: dispatch!,
      receipt: compilerReceiptFixture(),
    });

    const attemptId = createTaskCompilationAttemptId();
    const claim = ledger.claimDispatch(attemptId);
    expect(claim.kind).toBe('claimed');

    const result = await dispatch!({
      attemptId,
      batch: {
        batchId: TaskCompilationBatchIdSchema.parse('batch-1'),
        prompt: 'recovery prompt',
        envelope: compilerEnvelopeFixture(),
      },
      sessionScope: {
        kind: 'detached-fresh',
        operationId,
        programId: TaskCompilationProgramIdSchema.parse('prog-1'),
        batchId: TaskCompilationBatchIdSchema.parse('batch-1'),
        attemptId,
      },
      projectDir: '/test/project/dir',
    });

    expect(invokeCallCount).toBe(1);
    expect(result.status).toBe('completed');
    expect(result.text).toBe(taskMarkdown);
  });

  it('recovery dispatch invokes the planner with the project directory', async () => {
    let capturedProjectDir: string | null = null;
    const planner = createPlannerBase({
      invokePlan: async (opts) => {
        capturedProjectDir = opts.projectDir;
        return completedRunnerCall(taskMarkdown);
      },
      invokeEscalate: async () => completedRunnerCall(''),
      isAvailable: async () => true,
      capabilities: defaultCapabilities,
    });

    const dispatch = readPlannerCompilerDispatch(planner);
    installCompilerSeam(planner, {
      invocation: compilerInvocationFixture(),
      ledger: compilerLedgerFixture('op-project-dir'),
      dispatch: dispatch!,
      receipt: compilerReceiptFixture(),
    });

    await dispatch!({
      attemptId: createTaskCompilationAttemptId(),
      batch: {
        batchId: TaskCompilationBatchIdSchema.parse('batch-1'),
        prompt: 'test prompt',
        envelope: compilerEnvelopeFixture(),
      },
      sessionScope: {
        kind: 'detached-fresh',
        operationId: TaskCompilationOperationIdSchema.parse('op-project-dir'),
        programId: TaskCompilationProgramIdSchema.parse('prog-1'),
        batchId: TaskCompilationBatchIdSchema.parse('batch-1'),
        attemptId: createTaskCompilationAttemptId(),
      },
      projectDir: '/actual/repo/path',
    });

    expect(capturedProjectDir).toBe('/actual/repo/path');
  });

  it('throws task_compiler_capability_unsupported if invoked without an installed seam', async () => {
    const planner = createPlannerBase({
      invokePlan: async () => completedRunnerCall(''),
      invokeEscalate: async () => completedRunnerCall(''),
      isAvailable: async () => true,
      capabilities: defaultCapabilities,
    });
    const dispatch = readPlannerCompilerDispatch(planner);
    expect(dispatch).toBeTypeOf('function');
    const attemptId = createTaskCompilationAttemptId();
    const operationId = TaskCompilationOperationIdSchema.parse('op-1');
    const programId = TaskCompilationProgramIdSchema.parse('prog-1');
    const batchId = TaskCompilationBatchIdSchema.parse('batch-1');
    await expect(
      dispatch!({
        attemptId,
        batch: {
          batchId,
          prompt: 'prompt',
          envelope: compilerEnvelopeFixture(),
        },
        sessionScope: {
          kind: 'detached-fresh',
          operationId,
          programId,
          batchId,
          attemptId,
        },
        projectDir: '/actual/repo/path',
      }),
    ).rejects.toMatchObject({
      kind: 'task_compiler_capability_unsupported',
    });
  });
});

describe('createPlannerBase — compiler attachment', () => {
  function seamFor(planner: ReturnType<typeof createPlannerBase>): CompilerSeam {
    const dispatch = readPlannerCompilerDispatch(planner);
    if (dispatch === null) throw new Error('planner carries no compiler dispatch');
    return {
      invocation: compilerInvocationFixture(),
      ledger: compilerLedgerFixture('op-attachment'),
      dispatch,
      receipt: compilerReceiptFixture(),
    };
  }

  it('seam and refusal are mutually exclusive', async () => {
    const planner = createPlannerBase({
      invokePlan: async () => completedRunnerCall(taskMarkdown),
      invokeEscalate: async () => completedRunnerCall(''),
      isAvailable: async () => true,
      capabilities: defaultCapabilities,
    });

    installCompilerSeam(planner, seamFor(planner));
    expect(readPlannerCompilerSeam(planner)).not.toBeNull();
    expect(readPlannerCompilerRefusal(planner)).toBeNull();

    installCompilerRefusal(planner, {
      code: 'task_compiler_capability_unsupported',
      message: 'no verified compiler conformance evidence',
    });
    expect(readPlannerCompilerSeam(planner)).toBeNull();
    expect(readPlannerCompilerRefusal(planner)?.message).toBe(
      'no verified compiler conformance evidence',
    );
    await expect(
      planner.plan({ feature: 'feature', projectDir, callbacks: { onOutput: () => {} } }),
    ).rejects.toMatchObject({ kind: 'task_compiler_capability_unsupported' });

    installCompilerSeam(planner, seamFor(planner));
    expect(readPlannerCompilerRefusal(planner)).toBeNull();
    expect(readPlannerCompilerSeam(planner)).not.toBeNull();
  });
});
