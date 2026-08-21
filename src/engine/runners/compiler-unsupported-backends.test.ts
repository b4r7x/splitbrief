import { chmodSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Config } from '../../core/schemas/config.js';
import {
  capabilityTuple,
  unverifiedConformanceProof,
} from '#testing/helpers/factories/compiler-capability.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { makeRunnerGate } from '#testing/helpers/runner-gate.js';
import { createLegacyCommandInvoke } from '../planners/command-invoke.js';
import { createPlannerCallContext } from '../planners/call-context.js';
import {
  TaskCompilationBatchIdSchema,
  TaskCompilationOperationIdSchema,
  TaskCompilationProgramIdSchema,
  createTaskCompilationAttemptId,
} from '../../core/schemas/task-compilation.js';
import { COMPILER_SUPPORT_TABLE, admitCompilerCapability } from './compiler-capability.js';
import { CLI_COMPILER_EVIDENCE } from '../../core/runners/cli-tool-catalog.js';
import { admitCliCompilerRuntime } from './cli-tools/registry.js';
import { bindCompilerRuntimeEvidence } from './compiler-runtime-evidence.js';
import { createPlanner, type RunnerFactoryAuthority } from './factory.js';
import { executableReceipt } from '#testing/helpers/custom-command-based.js';

const OPERATION_ID = TaskCompilationOperationIdSchema.parse('operation-unsupported-matrix');

function authorityFor(config: Config): RunnerFactoryAuthority {
  const slot = { role: 'planner' as const };
  const preparationId = 'unsupported-backends-matrix';
  return {
    preparedConfig: config,
    preparationId,
    slot,
    gates: [makeRunnerGate(config.planner, slot, preparationId)],
  };
}

describe('compiler backend support matrix', () => {
  it('marks Copilot, Aider, and the legacy shell and agent planners typed-unsupported', () => {
    for (const backend of ['copilot', 'aider', 'shell', 'agent'] as const) {
      const row = COMPILER_SUPPORT_TABLE[backend];
      expect(row.state).toBe('unsupported');
      expect(row.transports).toEqual([]);
      expect(row.unsupportedReason?.length ?? 0).toBeGreaterThan(0);
    }
    expect(CLI_COMPILER_EVIDENCE.copilot.state).toBe('unsupported');
    expect(CLI_COMPILER_EVIDENCE.aider.state).toBe('unsupported');
  });

  it('keeps conditional rows conformance-gated and the baseline row explicit', () => {
    for (const backend of ['kilo-code', 'api', 'agent-sdk', 'custom-command'] as const) {
      expect(COMPILER_SUPPORT_TABLE[backend].state).toBe('conformance-gated');
    }
    expect(COMPILER_SUPPORT_TABLE.opencode.state).toBe('required-baseline');
    expect(COMPILER_SUPPORT_TABLE['claude-code'].state).toBe('conformance-gated');
    expect(COMPILER_SUPPORT_TABLE.codex.state).toBe('conformance-gated');
    expect(CLI_COMPILER_EVIDENCE['kilo-code'].state).toBe('conformance-gated');
  });
});

describe('unsupported CLI planner rows fail closed with zero dispatch', () => {
  it.each([
    ['copilot', 'session'],
    ['aider', 'provider-dependent'],
  ] as const)(
    'refuses the %s planner through the production factory before any spawn',
    async (tool, authChannel) => {
      const projectDir = createTempDir(`unsupported-${tool}-project`);
      const shimDir = createTempDir(`unsupported-${tool}-shim`);
      const marker = join(shimDir, 'spawned');
      const originalPath = process.env.PATH;
      try {
        createTestGitRepo(projectDir);
        writeFileSync(
          join(shimDir, tool),
          ['#!/bin/sh', `touch '${marker}'`, 'exit 0', ''].join('\n'),
          'utf8',
        );
        chmodSync(join(shimDir, tool), 0o755);
        process.env.PATH = `${shimDir}:${originalPath ?? ''}`;

        const config = makeConfig({
          planner: { kind: 'cli', tool, authChannel },
        });

        await expect(createPlanner(config, authorityFor(config))).rejects.toMatchObject({
          kind: 'task_compiler_capability_unsupported',
        });
        expect(existsSync(marker)).toBe(false);
      } finally {
        process.env.PATH = originalPath ?? '';
        cleanupTempDir(shimDir);
        cleanupTempDir(projectDir);
      }
    },
  );

  it.each(['shell', 'agent'] as const)(
    'refuses a compiler-grade %s planner batch with zero child spawns',
    async (backend) => {
      const projectDir = createTempDir(`unsupported-${backend}-project`);
      const sentinel = join(projectDir, 'child-spawned');
      const attemptId = createTaskCompilationAttemptId();
      const callContext = createPlannerCallContext({}, 'planner');
      const invoke = createLegacyCommandInvoke({
        command: process.execPath,
        args: ['-e', `require('fs').writeFileSync(${JSON.stringify(sentinel)}, 'x');`],
        notFoundMessage: `missing ${backend} command`,
        backendId: backend,
      });
      try {
        const result = await invoke({
          prompt: 'batch prompt',
          projectDir,
          callContext: {
            ...callContext,
            attemptId,
            sessionScope: {
              kind: 'detached-fresh',
              operationId: OPERATION_ID,
              programId: TaskCompilationProgramIdSchema.parse(`program-unsupported-${backend}`),
              batchId: TaskCompilationBatchIdSchema.parse(`batch-unsupported-${backend}`),
              attemptId,
            },
          },
          callbacks: { onOutput: () => {} },
        });

        expect(result.status).toBe('unsupported_tool');
        expect(result.terminalStatus).toBe('unsupported_tool');
        expect(result.failureCode).toBe('task_compiler_capability_unsupported');
        expect(result.error?.code).toBe('task_compiler_capability_unsupported');
        expect(String(result.error?.message)).toContain(backend);
        expect(existsSync(sentinel)).toBe(false);
      } finally {
        cleanupTempDir(projectDir);
      }
    },
  );
});

describe('conditional compiler paths stay inactive until conformance passes', () => {
  it('admits a drifted Kilo runtime at registry admission with drift evidence', () => {
    const runtime = bindCompilerRuntimeEvidence({
      backend: 'kilo-code',
      executable: executableReceipt(),
      version: '7.0.50',
    });
    expect(runtime.kind).toBe('bound');
    if (runtime.kind !== 'bound') return;
    expect(runtime.evidence.versionObservation).toBe('drifted');
    expect(runtime.evidence.runtimeVersion).toBe('7.0.50');

    const admission = admitCliCompilerRuntime({ tool: 'kilo-code', runtime: runtime.evidence });
    expect(admission.kind).toBe('admitted');
    if (admission.kind === 'admitted') {
      expect(admission.evidence.version).toBe('7.0.49');
    }
  });

  it('refuses a Kilo capability tuple whose conformance proof is unverified', () => {
    const admission = admitCompilerCapability(
      capabilityTuple('kilo-code', { conformance: unverifiedConformanceProof() }),
    );
    expect(admission.kind).toBe('refused');
    if (admission.kind === 'refused') {
      expect(admission.missing).toContain('conformance');
    }
  });

  it('refuses unsupported capability tuples even with a verified-looking proof', () => {
    for (const backend of ['copilot', 'aider', 'shell', 'agent'] as const) {
      const admission = admitCompilerCapability(
        capabilityTuple('opencode', {
          backend,
          version: '',
          terminalContract: 'unsupported',
          credentialChannel: 'api-key',
        }),
      );
      expect(admission.kind, backend).toBe('refused');
      if (admission.kind === 'refused') {
        expect(admission.missing).toContain('backend');
      }
    }
  });
});
