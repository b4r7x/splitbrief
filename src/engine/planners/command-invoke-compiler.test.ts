import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { normalizePlannerPhase } from './normalize.js';
import { createConfiguredCustomPlanner as createConfiguredCustomPlannerForTest } from './command-invoke.js';
import { createPlannerCallContext } from './call-context.js';
import { prepareCustomRunnerAdmission } from '../runners/custom-admission.js';
import {
  customRunnerSecurityPosture,
  type ConfiguredCustomRunner,
} from '../runners/custom-trust.js';
import type { RunnerGate } from '../runners/prepared-execution.js';
import type { CustomRunnerRuntimePort } from '../runners/types.js';
import type { DeclaredArtifactReceipt } from '../runners/types.js';
import type { RunnerCallContext } from '../calls/types.js';
import { customRunnerAdmissionError } from '../runners/custom-launchability.js';
import {
  TaskCompilationSemanticIdSchema,
  createTaskCompilationAttemptId,
  type TaskCompilationAttemptId,
} from '../../core/schemas/task-compilation.js';
import { makeRunnerCallResult } from '#testing/helpers/factories/runner-call.js';
import {
  configuredPlanner,
  createCommandInvokeTestFixtures,
  reviewCandidateRoot,
  runtimeFor,
} from '#testing/helpers/planner-command-invoke.js';

const { testProject } = createCommandInvokeTestFixtures();

async function createConfiguredCustomPlanner(
  runner: ConfiguredCustomRunner,
  runtime: CustomRunnerRuntimePort,
) {
  const admission = await prepareCustomRunnerAdmission({
    ...runtime.admission,
    projectDir: runtime.authorizationProjectDir,
    runner,
    posture: customRunnerSecurityPosture('planner', runner.command.contract),
    phase: 'planning',
    authorizationPathEnv: runtime.authorizationPathEnv ?? '',
    authorizationPathExt: runtime.authorizationPathExt ?? '',
  });
  if (admission.kind !== 'admitted') throw customRunnerAdmissionError.denied('planner');
  const gate = {
    kind: runner.command.contract === 'output' ? 'shell' : 'agent',
    slot: { role: 'planner' },
    preparationId: 'configured-compiler-test',
    command: { kind: 'configured-custom', invocation: admission.invocation },
  } satisfies RunnerGate;
  return createConfiguredCustomPlannerForTest(runner, runtime, gate.command.invocation);
}

function declaredFileContext(attemptId: TaskCompilationAttemptId): RunnerCallContext {
  return {
    callId: attemptId,
    attemptId,
    role: 'planner',
    backendKind: 'agent',
    transport: {
      kind: 'declared-file',
      lease: { leaseId: attemptId, attemptId, relativePath: 'result' },
    },
    sessionScope: { kind: 'workflow', workflowSessionId: null },
  };
}

function leaseReceipt(
  attemptId: TaskCompilationAttemptId,
  overrides: Partial<DeclaredArtifactReceipt> = {},
): DeclaredArtifactReceipt {
  return {
    semanticId: TaskCompilationSemanticIdSchema.parse('planner-artifact-tasks.md'),
    programId: null,
    batchId: null,
    attemptId,
    leaseId: attemptId,
    relativePath: 'result',
    inodeIdentity: 'inode-1',
    ancestryDigest: 'ancestry-1',
    sha256: 'artifact-sha-1',
    byteLength: Buffer.byteLength('content', 'utf8'),
    leaseReceiptDigest: 'lease-receipt-digest-1',
    ...overrides,
  };
}

describe('normalizePlannerPhase — exact declared-file receipt', () => {
  it('admits the exact attempt-bound receipt with unchanged identity', () => {
    const attemptId = createTaskCompilationAttemptId();
    const callContext = declaredFileContext(attemptId);
    const result = makeRunnerCallResult({ status: 'completed', text: 'content' });
    const phase = normalizePlannerPhase({
      result: { ...result, ownedArtifactReceipt: leaseReceipt(attemptId) },
      callContext,
      logicalName: 'tasks.md',
      text: 'content',
    });

    expect(phase.artifact).toMatchObject({
      attemptId,
      logicalName: 'tasks.md',
      transport: 'declared-file',
      semanticId: 'planner-artifact-tasks.md',
      programId: null,
      batchId: null,
      terminal: { status: 'completed', recordId: result.callId },
    });
    expect(phase.artifact.sourceReceipt).toMatchObject({
      kind: 'declared-file',
      leaseId: attemptId,
      inodeIdentity: 'inode-1',
      leaseReceiptDigest: 'lease-receipt-digest-1',
    });
  });

  it('rejects a missing receipt for a declared-file transport', () => {
    const attemptId = createTaskCompilationAttemptId();
    const callContext = declaredFileContext(attemptId);
    const result = makeRunnerCallResult({ status: 'completed', text: 'content' });
    expect(() =>
      normalizePlannerPhase({
        result: { ...result, ownedArtifactReceipt: undefined },
        callContext,
        logicalName: 'tasks.md',
        text: 'content',
      }),
    ).toThrow(expect.objectContaining({ kind: 'custom-planner-artifact-invalid' }));
  });

  it('rejects a receipt bound to a different attempt identity', () => {
    const attemptId = createTaskCompilationAttemptId();
    const callContext = declaredFileContext(attemptId);
    const result = makeRunnerCallResult({ status: 'completed', text: 'content' });
    expect(() =>
      normalizePlannerPhase({
        result: {
          ...result,
          ownedArtifactReceipt: leaseReceipt(createTaskCompilationAttemptId()),
        },
        callContext,
        logicalName: 'tasks.md',
        text: 'content',
      }),
    ).toThrow(expect.objectContaining({ kind: 'custom-planner-artifact-invalid' }));
  });

  it('rejects a receipt bound to a different lease identity', () => {
    const attemptId = createTaskCompilationAttemptId();
    const callContext = declaredFileContext(attemptId);
    const result = makeRunnerCallResult({ status: 'completed', text: 'content' });
    expect(() =>
      normalizePlannerPhase({
        result: {
          ...result,
          ownedArtifactReceipt: leaseReceipt(attemptId, { leaseId: 'other-lease' }),
        },
        callContext,
        logicalName: 'tasks.md',
        text: 'content',
      }),
    ).toThrow(expect.objectContaining({ kind: 'custom-planner-artifact-invalid' }));
  });

  it('rejects a receipt bound to a different lease path', () => {
    const attemptId = createTaskCompilationAttemptId();
    const callContext = declaredFileContext(attemptId);
    const result = makeRunnerCallResult({ status: 'completed', text: 'content' });
    expect(() =>
      normalizePlannerPhase({
        result: {
          ...result,
          ownedArtifactReceipt: leaseReceipt(attemptId, { relativePath: 'other/result' }),
        },
        callContext,
        logicalName: 'tasks.md',
        text: 'content',
      }),
    ).toThrow(expect.objectContaining({ kind: 'custom-planner-artifact-invalid' }));
  });

  it('derives the stdout-final receipt from the current result bytes only', () => {
    const attemptId = createTaskCompilationAttemptId();
    const callContext = {
      ...createPlannerCallContext({}, 'planner'),
      callId: attemptId,
      attemptId,
    };
    const result = makeRunnerCallResult({ status: 'completed', text: 'current result' });
    const phase = normalizePlannerPhase({
      result,
      callContext,
      logicalName: 'plan.md',
      text: 'current result',
    });

    expect(phase.artifact).toMatchObject({
      attemptId,
      logicalName: 'plan.md',
      transport: 'stdout-final',
      semanticId: `planner-artifact-${result.callId}-plan.md`,
    });
    expect(phase.artifact.sourceReceipt).toMatchObject({
      kind: 'stdout-final',
      resultDigest: phase.artifact.runtimeReceipt,
    });
  });
});

const PLAN_DOC = `# Plan

## File Structure
### New Files
- \`src/generated/file-1.ts\`
  Purpose: implement file 1.

### Modified Files

## Dependencies
None.`;

const BRIEF_DOC = `---
id: T001
title: Test task
action: create
file: src/generated/file-1.ts
depends_on: []
---

# Plan

### Description
Create the example file.

### Implementation Steps
1. Write the file.

### Tests
- npm test

### Constraints
- Follow project conventions.
`;

function directPlannerScript(body: string): string {
  return [
    "const fs = require('fs');",
    "const input = fs.readFileSync(0, 'utf8');",
    body,
    "const out = input.includes('Write Implementation Plan')"
      .concat(` ? ${JSON.stringify(PLAN_DOC)}`)
      .concat(" : input.includes('Write Feature Specification')")
      .concat(` ? ${JSON.stringify('# Spec\n\nRequirements.')}`)
      .concat(" : input.includes('Research Task')")
      .concat(` ? ${JSON.stringify('# Research\n\n**Language**: TypeScript\n\nFindings.')}`)
      .concat(` : ${JSON.stringify(BRIEF_DOC)};`),
    `fs.writeFileSync(process.env.SPLITBRIEF_DECLARED_ARTIFACT_PATH, out);`,
    "process.stdout.write('diagnostic stdout');",
  ].join('\n');
}

describe('createConfiguredCustomPlanner — compiler-grade phase identity', () => {
  it('promotes only the exact current lease receipt with invocation-unique attempts', async () => {
    const { projectDir, stateDir } = testProject('configured-compiler-identity');
    const approvals: string[] = [];
    const planner = await createConfiguredCustomPlanner(
      configuredPlanner({
        contract: 'direct',
        script: directPlannerScript(''),
      }),
      runtimeFor({
        projectDir,
        stateDir,
        onApprovalNeeded: async (_type, review) => {
          approvals.push(review.text);
          return { approved: true };
        },
      }),
    );

    const result = await planner.plan({
      feature: 'configured identity feature',
      projectDir,
      callbacks: {
        onOutput: vi.fn(),
        onPhase: vi.fn(),
        onWarning: vi.fn(),
        persistTranscript: false,
      },
      skillsContext: '',
      codebaseContext: '',
    });

    expect(result.tasks.map((task) => task.id)).toEqual(['T001']);
    expect(result.phases).toHaveLength(4);
    const artifacts = result.phases?.map((phase) => phase.artifact) ?? [];
    expect(new Set(artifacts.map((artifact) => artifact.attemptId)).size).toBe(4);
    expect(artifacts.map((artifact) => artifact.logicalName)).toEqual([
      'research.md',
      'spec.md',
      'plan.md',
      'tasks.md',
    ]);
    for (const artifact of artifacts) {
      expect(artifact.transport).toBe('declared-file');
      expect(artifact.semanticId).toBe(`planner-artifact-${artifact.logicalName}`);
      expect(artifact.terminal).toMatchObject({ status: 'completed' });
      expect(artifact.sourceReceipt).toMatchObject({
        kind: 'declared-file',
        leaseId: artifact.attemptId,
      });
    }
    expect(approvals).toHaveLength(4);
    expect(existsSync(join(projectDir, '.splitbrief-runner'))).toBe(false);
    expect(existsSync(reviewCandidateRoot(projectDir))).toBe(false);
  });

  it('rejects a missing lease receipt with zero approval and zero candidate', async () => {
    const { projectDir, stateDir } = testProject('configured-compiler-missing-lease');
    let approvalRequests = 0;
    const planner = await createConfiguredCustomPlanner(
      configuredPlanner({
        contract: 'direct',
        script: "process.stdout.write('diagnostic only');",
      }),
      runtimeFor({
        projectDir,
        stateDir,
        onApprovalNeeded: async () => {
          approvalRequests += 1;
          return { approved: true };
        },
      }),
    );

    await expect(
      planner.plan({
        feature: 'missing lease feature',
        projectDir,
        callbacks: {
          onOutput: vi.fn(),
          onPhase: vi.fn(),
          onWarning: vi.fn(),
          persistTranscript: false,
        },
        skillsContext: '',
        codebaseContext: '',
      }),
    ).rejects.toMatchObject({ kind: 'custom-planner-artifact-invalid' });

    expect(approvalRequests).toBe(0);
    expect(existsSync(join(projectDir, '.splitbrief-runner'))).toBe(false);
    expect(existsSync(reviewCandidateRoot(projectDir))).toBe(false);
  });

  it('rejects an ambient stage write outside the declared lease and promotes nothing', async () => {
    const { projectDir, stateDir } = testProject('configured-compiler-ambient-write');
    const planner = await createConfiguredCustomPlanner(
      configuredPlanner({
        contract: 'direct',
        script: directPlannerScript(
          "if (input.includes('Research Task')) fs.writeFileSync('undeclared-write.txt', 'reject');",
        ),
      }),
      runtimeFor({ projectDir, stateDir }),
    );

    await expect(
      planner.plan({
        feature: 'ambient write feature',
        projectDir,
        callbacks: {
          onOutput: vi.fn(),
          onPhase: vi.fn(),
          onWarning: vi.fn(),
          persistTranscript: false,
        },
        skillsContext: '',
        codebaseContext: '',
      }),
    ).rejects.toMatchObject({ kind: 'custom-planner-artifact-invalid' });

    expect(existsSync(join(projectDir, 'undeclared-write.txt'))).toBe(false);
    expect(existsSync(join(projectDir, '.splitbrief-runner'))).toBe(false);
    expect(existsSync(reviewCandidateRoot(projectDir))).toBe(false);
  });
});

describe('createConfiguredCustomPlanner — stale ambient review cleanup', () => {
  it('never admits a stale review root from a previous call', async () => {
    const { projectDir, stateDir } = testProject('configured-compiler-stale');
    const staleRoot = reviewCandidateRoot(projectDir);
    mkdirSync(join(staleRoot, 'stale-call'), { recursive: true });
    writeFileSync(join(staleRoot, 'stale-call', 'result'), 'stale ambient content');

    const planner = await createConfiguredCustomPlanner(
      configuredPlanner({
        contract: 'direct',
        script: directPlannerScript(''),
      }),
      runtimeFor({ projectDir, stateDir }),
    );

    const result = await planner.plan({
      feature: 'stale cleanup feature',
      projectDir,
      callbacks: {
        onOutput: vi.fn(),
        onPhase: vi.fn(),
        onWarning: vi.fn(),
        persistTranscript: false,
      },
      skillsContext: '',
      codebaseContext: '',
    });

    expect(result.phases?.[0]?.artifact.text).not.toContain('stale ambient content');
    expect(existsSync(staleRoot)).toBe(false);
  });
});
