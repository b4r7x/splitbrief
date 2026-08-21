import { describe, expect, it } from 'vitest';
import { makeRunnerCallResult } from '#testing/helpers/factories/runner-call.js';
import { runMultiPhasePlanning } from './multi-phase.js';
import type { PlannerCallbacks } from './types.js';
import type { RunnerCallContext } from '../calls/types.js';
import type { PreparedPlannerInvocation } from '../runners/types.js';
import type { TaskCompilationSessionScope } from '../../core/schemas/task-compilation.js';
import {
  TASK_BRIEF_COMPILER_POLICY,
  TaskCompilationOperationIdSchema,
  type TaskCompilationCallEnvelope,
} from '../../core/schemas/task-compilation.js';
import { createTaskDispatchClaimPort, createTaskDispatchLedger } from '../calls/dispatch-ledger.js';
import { materializeTaskCompilationProgram } from '../spec/tasks/compiler.js';
import { parseTaskManifest } from '../spec/tasks/manifest.js';

function completed(text: string) {
  return makeRunnerCallResult({ status: 'completed', text });
}

const callbacks = { onOutput: () => {} };

function completedForCallContext(callContext: RunnerCallContext, text: string) {
  return {
    ...makeRunnerCallResult({
      status: 'completed',
      text,
      callId: callContext.callId,
      role: 'planner',
    }),
    attemptId: callContext.attemptId,
  };
}

const OPERATION_ID = TaskCompilationOperationIdSchema.parse('operation-multi-phase-test');

function planWithFiles(count: number): string {
  const newFiles = Array.from(
    { length: count },
    (_, index) =>
      `- \`src/generated/file-${index + 1}.ts\`\n  Purpose: implement file ${index + 1}.`,
  ).join('\n');
  return `# Plan\n\n## File Structure\n### New Files\n${newFiles}\n\n### Modified Files\n\n## Dependencies\nNone.`;
}

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
      executablePath: '/usr/bin/fake-compiler',
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

function briefBlock(id: string, file: string): string {
  return `---
id: ${id}
title: "Task ${id}"
action: create
file: ${file}
depends_on: []
---

### Description
Implement ${file}.

### Tests
- ${id} works

### Constraints
- none
`;
}

type CompilerHarness = Readonly<{
  spec: string;
  plan: string;
  research: string;
  program: ReturnType<typeof materializeTaskCompilationProgram>;
  ledger: ReturnType<typeof createTaskDispatchLedger>;
  briefs: string[];
}>;

function compilerHarness(fileCount: number): CompilerHarness {
  const spec = '# Spec\n\nRequirements.';
  const plan = planWithFiles(fileCount);
  const research = '# Research\n\n**Language**: TypeScript\n\nFindings.';
  const program = materializeTaskCompilationProgram(
    { spec, plan, languageContext: 'TypeScript' },
    { envelope: envelopeFixture() },
  );
  const ledger = createTaskDispatchLedger({
    operation: program.operationEnvelope,
    operationId: OPERATION_ID,
    claimPort: createTaskDispatchClaimPort(),
  });
  const briefs = parseTaskManifest(plan).items.map((item) => briefBlock(item.id, item.file));
  return { spec, plan, research, program, ledger, briefs };
}

describe('runMultiPhasePlanning artifact admission', () => {
  it('does not pass an invalid spec to the plan phase', async () => {
    const prompts: string[] = [];
    const outputs = ['# Research\n\nFindings.', 'Which scope should tasks.md cover?'];

    await expect(
      runMultiPhasePlanning(
        {
          invokePlan: async ({ prompt }) => {
            prompts.push(prompt);
            return completed(outputs[prompts.length - 1] ?? '');
          },
        },
        { feature: 'feature', projectDir: '/tmp', callbacks },
      ),
    ).rejects.toMatchObject({
      kind: 'planning-invalid-artifact',
      data: { phase: 'specifying', filename: 'spec.md' },
    });

    expect(prompts).toHaveLength(2);
  });

  it('does not pass an invalid plan to the task phase', async () => {
    const prompts: string[] = [];
    const outputs = [
      '# Research\n\nFindings.',
      '# Spec\n\nRequirements.',
      'Which scope should tasks.md cover?',
    ];

    await expect(
      runMultiPhasePlanning(
        {
          invokePlan: async ({ prompt }) => {
            prompts.push(prompt);
            return completed(outputs[prompts.length - 1] ?? '');
          },
        },
        { feature: 'feature', projectDir: '/tmp', callbacks },
      ),
    ).rejects.toMatchObject({
      kind: 'planning-invalid-artifact',
      data: { phase: 'planning', filename: 'plan.md' },
    });

    expect(prompts).toHaveLength(3);
  });
});

describe('runMultiPhasePlanning — detached compiler batches', () => {
  it('compiles Task production through detached fresh scopes with zero workflow callbacks', async () => {
    const h = compilerHarness(2);
    const invokeCalls: Array<{
      callContext: RunnerCallContext;
      callbacksSessionId: string | undefined;
    }> = [];
    const workflowCalls = {
      onOutput: 0,
      onQuestion: 0,
      onSessionId: 0,
      onSessionExpired: 0,
      onCallEvent: 0,
    };
    const workflowCallbacks: PlannerCallbacks = {
      onOutput: () => {
        workflowCalls.onOutput += 1;
      },
      onQuestion: () => {
        workflowCalls.onQuestion += 1;
      },
      onSessionId: () => {
        workflowCalls.onSessionId += 1;
      },
      onSessionExpired: () => {
        workflowCalls.onSessionExpired += 1;
      },
      onCallEvent: () => {
        workflowCalls.onCallEvent += 1;
      },
      onPhase: () => {},
      onWarning: () => {},
      sessionId: 'sess-workflow',
    };

    const result = await runMultiPhasePlanning(
      {
        invokePlan: async ({ callContext, callbacks: invokeCallbacks }) => {
          invokeCalls.push({ callContext, callbacksSessionId: invokeCallbacks.sessionId });
          const scope = callContext.sessionScope;
          if (scope?.kind === 'detached-fresh') {
            const batchIndex = h.program.batches.findIndex(
              (batch) => batch.batchId === scope.batchId,
            );
            const batch = h.program.batches[batchIndex];
            if (batch === undefined) throw new Error(`unknown batch ${scope.batchId}`);
            invokeCallbacks.onOutput?.('streamed batch chunk');
            return completedForCallContext(
              callContext,
              batch.manifestOrdinals.map((ordinal) => h.briefs[ordinal] ?? '').join('\n'),
            );
          }
          if (invokeCalls.length === 1) return completedForCallContext(callContext, h.research);
          if (invokeCalls.length === 2)
            return completedForCallContext(callContext, '# Spec\n\nRequirements.');
          if (invokeCalls.length === 3) return completedForCallContext(callContext, h.plan);
          throw new Error(`unexpected invoke ${invokeCalls.length}`);
        },
        compiler: { invocation: invocationFixture(), ledger: h.ledger },
      },
      { feature: 'feature', projectDir: '/tmp', callbacks: workflowCallbacks },
    );

    expect(invokeCalls).toHaveLength(4);
    const batchCall = invokeCalls[3];
    expect(batchCall?.callContext.sessionScope).toMatchObject({
      kind: 'detached-fresh',
      operationId: OPERATION_ID,
      programId: h.program.programId,
      batchId: h.program.batches[0]?.batchId,
    });
    expect(batchCall?.callbacksSessionId).toBeUndefined();
    expect(workflowCalls).toEqual({
      onOutput: 0,
      onQuestion: 0,
      onSessionId: 0,
      onSessionExpired: 0,
      onCallEvent: 0,
    });
    expect(result.tasks.map((task) => task.id)).toEqual(['T001', 'T002']);
    expect(result.phases).toHaveLength(4);
    const batchPhase = result.phases?.find((phase) => phase.artifact.logicalName === 'tasks.md');
    expect(batchPhase?.artifact).toMatchObject({
      transport: 'stdout-final',
      attemptId: batchCall?.callContext.attemptId,
      programId: h.program.programId,
      batchId: h.program.batches[0]?.batchId,
      semanticId: `tasks-${h.program.programId}`,
    });
  });

  it('gives every batch a distinct detached fresh scope and claims the ledger per batch', async () => {
    const h = compilerHarness(6);
    const batchScopes: Extract<TaskCompilationSessionScope, { kind: 'detached-fresh' }>[] = [];
    let supportCount = 0;

    const result = await runMultiPhasePlanning(
      {
        invokePlan: async ({ callContext }) => {
          const scope = callContext.sessionScope;
          if (scope?.kind === 'detached-fresh') {
            batchScopes.push(scope);
            const batchIndex = h.program.batches.findIndex(
              (batch) => batch.batchId === scope.batchId,
            );
            const batch = h.program.batches[batchIndex];
            if (batch === undefined) throw new Error(`unknown batch ${scope.batchId}`);
            return completedForCallContext(
              callContext,
              batch.manifestOrdinals.map((ordinal) => h.briefs[ordinal] ?? '').join('\n'),
            );
          }
          supportCount += 1;
          if (supportCount === 1) {
            return completedForCallContext(callContext, h.research);
          }
          if (supportCount === 2) {
            return completedForCallContext(callContext, '# Spec\n\nRequirements.');
          }
          return completedForCallContext(callContext, h.plan);
        },
        compiler: { invocation: invocationFixture(), ledger: h.ledger },
      },
      { feature: 'feature', projectDir: '/tmp', callbacks },
    );

    expect(batchScopes).toHaveLength(2);
    expect(batchScopes.map((scope) => scope.kind)).toEqual(['detached-fresh', 'detached-fresh']);
    expect(batchScopes.map((scope) => scope.batchId)).toEqual([
      h.program.batches[0]?.batchId,
      h.program.batches[1]?.batchId,
    ]);
    expect(batchScopes.map((scope) => scope.programId)).toEqual([
      h.program.programId,
      h.program.programId,
    ]);
    expect(batchScopes[0]?.attemptId).not.toBe(batchScopes[1]?.attemptId);
    const snapshot = h.ledger.snapshot();
    expect(snapshot.dispatchCount).toBe(2);
    expect(snapshot.claimedAttemptIds).toContain(batchScopes[0]?.attemptId ?? '');
    expect(snapshot.claimedAttemptIds).toContain(batchScopes[1]?.attemptId ?? '');
    expect(result.tasks.map((task) => task.id)).toEqual([
      'T001',
      'T002',
      'T003',
      'T004',
      'T005',
      'T006',
    ]);
    const batchPhases = result.phases?.filter((phase) => phase.artifact.logicalName === 'tasks.md');
    expect(batchPhases).toHaveLength(2);
    expect(batchPhases?.[0]?.artifact.attemptId).toBe(batchScopes[0]?.attemptId);
    expect(batchPhases?.[1]?.artifact.attemptId).toBe(batchScopes[1]?.attemptId);
  });
});
