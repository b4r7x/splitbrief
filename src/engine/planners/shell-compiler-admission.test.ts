import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createShellPlanner } from './shell.js';
import { createLegacyCommandInvoke } from './command-invoke.js';
import { runMultiPhasePlanning } from './multi-phase.js';
import { createPlannerCallContext } from './call-context.js';
import { createTaskDispatchClaimPort, createTaskDispatchLedger } from '../calls/dispatch-ledger.js';
import { materializeTaskCompilationProgram } from '../spec/tasks/compiler.js';
import { COMPILER_SUPPORT_TABLE } from '../runners/compiler-capability.js';
import {
  TASK_BRIEF_COMPILER_POLICY,
  TaskCompilationBatchIdSchema,
  TaskCompilationOperationIdSchema,
  TaskCompilationProgramIdSchema,
  createTaskCompilationAttemptId,
  type TaskCompilationAttemptId,
  type TaskCompilationCallEnvelope,
} from '../../core/schemas/task-compilation.js';
import type { PreparedPlannerInvocation } from '../runners/types.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';

const OPERATION_ID = TaskCompilationOperationIdSchema.parse('operation-shell-admission');

function envelopeFixture(): TaskCompilationCallEnvelope {
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

function invocationFixture(): PreparedPlannerInvocation {
  return {
    runtime: {
      executablePath: '/usr/bin/fake-shell-compiler',
      version: 'fixture-1.0.0',
      runtimeDigest: 'runtime-fixture-digest',
      protocolDigest: 'protocol-fixture-digest',
    },
    role: 'planner-read-only',
    transport: { kind: 'stdout-final' },
    terminalContract: 'fixture-terminal',
    envelope: envelopeFixture(),
    capabilityDigest: 'capability-fixture-digest',
  };
}

const PLAN_DOC = `# Plan

## File Structure
### New Files
- \`src/generated/file-1.ts\`
  Purpose: implement file 1.

### Modified Files

## Dependencies
None.`;

function shellScript(logPath: string): string {
  return [
    "const fs = require('fs');",
    "const input = fs.readFileSync(0, 'utf8');",
    `fs.appendFileSync(${JSON.stringify(logPath)}, input.includes('Compile Product Task Briefs') ? 'batch\\n' : 'support\\n');`,
    'let out;',
    `if (input.includes('Write Implementation Plan')) { out = ${JSON.stringify(PLAN_DOC)}; }`,
    "else if (input.includes('Write Feature Specification')) { out = '# Spec\\n\\nRequirements.'; }",
    "else if (input.includes('Research Task')) { out = '# Research\\n\\n**Language**: TypeScript\\n\\nFindings.'; }",
    "else { out = '# Research\\n\\nFindings.'; }",
    'process.stdout.write(out);',
  ].join('\n');
}

function spawnCount(logPath: string, kind: 'support' | 'batch'): number {
  const lines = readFileSync(logPath, 'utf8').split('\n');
  return lines.filter((line) => line === kind).length;
}

describe('legacy shell planner compiler admission', () => {
  it('constructs the legacy shell planner without ambient fallback', () => {
    const planner = createShellPlanner(
      makeConfig({
        planner: { kind: 'shell', command: process.execPath, args: ['-e', ''] },
      }),
    );
    expect(planner.capabilities).toMatchObject({
      supportsConversationalPlanning: false,
      supportsHintEscalation: false,
      supportsSessionResume: false,
      supportsEffort: false,
      supportsImages: false,
      supportsSelfSummarisation: false,
    });
  });

  it('reads the typed-unsupported shell row from the capability registry', () => {
    const row = COMPILER_SUPPORT_TABLE.shell;
    expect(row.state).toBe('unsupported');
    expect(row.transports).toEqual([]);
    expect(row.unsupportedReason).toContain('containment and final-response conformance');
  });

  it('refuses compiler batch dispatch with a typed capability failure and zero batch spawns', async () => {
    const projectDir = createTempDir('shell-admission-compiler');
    createTestGitRepo(projectDir);
    const logPath = join(projectDir, 'spawns.log');
    const spec = '# Spec\n\nRequirements.';
    const program = materializeTaskCompilationProgram(
      { spec, plan: PLAN_DOC, languageContext: 'TypeScript' },
      { envelope: envelopeFixture() },
    );
    const ledger = createTaskDispatchLedger({
      operation: program.operationEnvelope,
      operationId: OPERATION_ID,
      claimPort: createTaskDispatchClaimPort(),
    });
    const invoke = createLegacyCommandInvoke({
      command: process.execPath,
      args: ['-e', shellScript(logPath)],
      outputFormat: 'text',
      notFoundMessage: 'Shell planner command not found',
      backendId: 'shell',
    });
    try {
      const failure = await runMultiPhasePlanning(
        {
          invokePlan: invoke,
          backendKind: 'cli',
          runnerName: 'shell-admission-test',
          compiler: { invocation: invocationFixture(), ledger },
        },
        {
          feature: 'shell admission feature',
          projectDir,
          callbacks: {
            onOutput: () => {},
            onPhase: () => {},
            onWarning: () => {},
            persistTranscript: false,
          },
          skillsContext: '',
          codebaseContext: '',
        },
      ).then(
        () => null,
        (err: unknown) => err,
      );

      expect(failure).toMatchObject({ kind: 'task_compiler_capability_unsupported' });
      expect(spawnCount(logPath, 'support')).toBe(3);
      expect(spawnCount(logPath, 'batch')).toBe(0);
      expect(ledger.snapshot().dispatchCount).toBe(1);
    } finally {
      cleanupTempDir(projectDir);
    }
  });

  it('refuses a declared-file compiler transport before spawning the shell command', async () => {
    const projectDir = createTempDir('shell-admission-declared-file');
    const sentinel = join(projectDir, 'child-spawned');
    const attemptId = createTaskCompilationAttemptId();
    const callContext = createPlannerCallContext({}, 'planner');
    const invoke = createLegacyCommandInvoke({
      command: process.execPath,
      args: ['-e', `require('fs').writeFileSync(${JSON.stringify(sentinel)}, 'x');`],
      notFoundMessage: 'missing shell command',
      backendId: 'shell',
    });
    try {
      const result = await invoke({
        prompt: 'batch prompt',
        projectDir,
        callContext: {
          ...callContext,
          transport: {
            kind: 'declared-file',
            lease: { leaseId: 'lease-1', attemptId, relativePath: 'result' },
          },
        },
        callbacks: { onOutput: () => {} },
      });

      expect(result.status).toBe('unsupported_tool');
      expect(result.terminalStatus).toBe('unsupported_tool');
      expect(result.failureCode).toBe('task_compiler_capability_unsupported');
      expect(result.error?.code).toBe('task_compiler_capability_unsupported');
      expect(String(result.error?.message)).toContain('legacy shell planner');
      expect(result.text).toBe('');
      expect(result.usage).toBeNull();
      expect(existsSync(sentinel)).toBe(false);
    } finally {
      cleanupTempDir(projectDir);
    }
  });

  it('refuses a detached-fresh compiler scope before spawning the shell command', async () => {
    const projectDir = createTempDir('shell-admission-detached');
    const sentinel = join(projectDir, 'child-spawned');
    const attemptId: TaskCompilationAttemptId = createTaskCompilationAttemptId();
    const callContext = createPlannerCallContext({}, 'planner');
    const invoke = createLegacyCommandInvoke({
      command: process.execPath,
      args: ['-e', `require('fs').writeFileSync(${JSON.stringify(sentinel)}, 'x');`],
      notFoundMessage: 'missing shell command',
      backendId: 'shell',
    });
    try {
      const result = await invoke({
        prompt: 'batch prompt',
        projectDir,
        callContext: {
          ...callContext,
          sessionScope: {
            kind: 'detached-fresh',
            operationId: OPERATION_ID,
            programId: TaskCompilationProgramIdSchema.parse('program-shell-admission'),
            batchId: TaskCompilationBatchIdSchema.parse('batch-shell-admission'),
            attemptId,
          },
        },
        callbacks: { onOutput: () => {} },
      });

      expect(result.status).toBe('unsupported_tool');
      expect(result.failureCode).toBe('task_compiler_capability_unsupported');
      expect(existsSync(sentinel)).toBe(false);
    } finally {
      cleanupTempDir(projectDir);
    }
  });

  it('refuses a compiler call envelope before spawning the shell command', async () => {
    const projectDir = createTempDir('shell-admission-envelope');
    const sentinel = join(projectDir, 'child-spawned');
    const callContext = createPlannerCallContext({}, 'planner');
    const invoke = createLegacyCommandInvoke({
      command: process.execPath,
      args: ['-e', `require('fs').writeFileSync(${JSON.stringify(sentinel)}, 'x');`],
      notFoundMessage: 'missing shell command',
      backendId: 'shell',
    });
    try {
      const result = await invoke({
        prompt: 'batch prompt',
        projectDir,
        callContext: { ...callContext, envelope: envelopeFixture() },
        callbacks: { onOutput: () => {} },
      });

      expect(result.status).toBe('unsupported_tool');
      expect(result.failureCode).toBe('task_compiler_capability_unsupported');
      expect(existsSync(sentinel)).toBe(false);
    } finally {
      cleanupTempDir(projectDir);
    }
  });
});

describe('legacy shell planner attempt identity on refusal', () => {
  it('carries the claimed batch attempt identity without claiming usage', async () => {
    const projectDir = createTempDir('shell-admission-identity');
    const attemptId = createTaskCompilationAttemptId();
    const callContext = {
      ...createPlannerCallContext({}, 'planner'),
      callId: attemptId,
      attemptId,
      sessionScope: {
        kind: 'detached-fresh' as const,
        operationId: OPERATION_ID,
        programId: TaskCompilationProgramIdSchema.parse('program-shell-identity'),
        batchId: TaskCompilationBatchIdSchema.parse('batch-shell-identity'),
        attemptId,
      },
    };
    const invoke = createLegacyCommandInvoke({
      command: process.execPath,
      args: ['-e', ''],
      notFoundMessage: 'missing shell command',
      backendId: 'shell',
    });
    try {
      const result = await invoke({
        prompt: 'batch prompt',
        projectDir,
        callContext,
        callbacks: { onOutput: () => {} },
      });

      expect(result.callId).toBe(attemptId);
      expect(result.attemptId).toBe(attemptId);
      expect(result.status).toBe('unsupported_tool');
      expect(result.failureCode).toBe('task_compiler_capability_unsupported');
    } finally {
      cleanupTempDir(projectDir);
    }
  });
});
