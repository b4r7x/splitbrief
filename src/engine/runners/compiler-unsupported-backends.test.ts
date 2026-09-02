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
import { CLI_COMPILER_EVIDENCE, CLI_TOOL_CATALOG } from '../../core/runners/cli-tool-catalog.js';
import { admitCliCompilerRuntime } from './cli-tools/registry.js';
import { bindCompilerRuntimeEvidence } from './compiler-runtime-evidence.js';
import { createPlanner } from './factory.js';
import type { RunnerFactoryAuthority } from './factory-gates.js';
import { installRunCompiler } from './compiler-seam.js';
import { readPlannerCompilerRefusal, readPlannerCompilerSeam } from '../planners/base.js';
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
  it('keeps the CLI compiler evidence in agreement with the unsupported support-table rows', () => {
    for (const tool of ['copilot', 'cursor', 'command-code'] as const) {
      expect(CLI_COMPILER_EVIDENCE[tool].state).toBe('unsupported');
      expect(CLI_COMPILER_EVIDENCE[tool].state).toBe(COMPILER_SUPPORT_TABLE[tool].state);
    }
  });

  it('keeps conditional rows conformance-gated and the baseline row explicit', () => {
    for (const backend of ['kilo-code', 'api', 'custom-command'] as const) {
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
    ['cursor', 'session'],
    ['command-code', 'session'],
  ] as const)(
    'refuses the %s planner through the production factory before any spawn',
    async (tool, authChannel) => {
      const projectDir = createTempDir(`unsupported-${tool}-project`);
      const shimDir = createTempDir(`unsupported-${tool}-shim`);
      const marker = join(shimDir, 'spawned');
      const shimPath = join(shimDir, CLI_TOOL_CATALOG[tool].command);
      const originalPath = process.env.PATH;
      try {
        createTestGitRepo(projectDir);
        writeFileSync(
          shimPath,
          ['#!/bin/sh', `touch '${marker}'`, 'exit 0', ''].join('\n'),
          'utf8',
        );
        chmodSync(shimPath, 0o755);
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

  it.each(['shell', 'agent'] as const)(
    'installs a zero-dispatch compiler refusal for a legacy %s planner',
    async (kind) => {
      const config = makeConfig({ planner: { kind, command: 'echo', args: [] } });
      const planner = await createPlanner(config, authorityFor(config));

      await installRunCompiler({ planner, config, projectDir: undefined, trustedCli: undefined });

      expect(readPlannerCompilerSeam(planner)).toBeNull();
      expect(readPlannerCompilerRefusal(planner)).toMatchObject({
        code: 'task_compiler_capability_unsupported',
      });
    },
  );
});
