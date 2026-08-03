import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeCustomCommand } from '../../core/config/custom-commands.js';
import { beginDeclaredArtifactReview } from '../orchestrator/approval/planner-artifact.js';
import { createStagedProject } from '../orchestrator/approval/staged-project.js';
import {
  customRunnerSecurityPosture,
  type ConfiguredCustomRunner,
} from '../runners/custom-trust.js';
import { prepareCustomRunnerAdmission } from '../runners/custom-admission.js';
import type { RunnerGate } from '../runners/prepared-execution.js';
import type { CustomRunnerRuntimePort } from '../runners/types.js';
import { createConfiguredCustomPlanner } from './command-invoke.js';
import {
  createCommandInvokeTestFixtures,
  reviewCandidateRoot,
  runtimeFor,
} from '#testing/helpers/planner-command-invoke.js';
import {
  admittedCustomRunner,
  observeCustomInvocation,
} from '#testing/helpers/custom-command-based.js';

const { testProject } = createCommandInvokeTestFixtures();

async function createPreparedPlanner(
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
  if (admission.kind !== 'admitted') throw new Error('Expected configured runner admission.');
  const gate = {
    kind: 'agent',
    slot: { role: 'planner' },
    preparationId: 'configured-terminal-test',
    command: { kind: 'configured-custom', invocation: admission.invocation },
  } satisfies RunnerGate;
  return createConfiguredCustomPlanner(runner, runtime, gate.command.invocation);
}

describe('configured direct planner terminal cleanup', () => {
  type TerminalRunnerOptions = Readonly<{
    outputFormat?: 'stream-json';
    idleWarnMs?: number;
    idleKillMs?: number;
    env?: readonly string[];
  }>;

  function terminalRunner(
    name: string,
    script: string,
    options: TerminalRunnerOptions = {},
  ): ConfiguredCustomRunner {
    return {
      source: 'configured',
      command: normalizeCustomCommand(`planner-direct-terminal-${name}`, {
        label: `Planner direct terminal ${name}`,
        contract: 'direct',
        executable: process.execPath,
        argv: ['-e', script],
        ...(options.outputFormat === undefined ? {} : { outputFormat: options.outputFormat }),
        ...(options.idleWarnMs === undefined ? {} : { idleWarnMs: options.idleWarnMs }),
        ...(options.idleKillMs === undefined ? {} : { idleKillMs: options.idleKillMs }),
        ...(options.env === undefined ? {} : { env: [...options.env] }),
      }),
    };
  }

  async function expectTerminalFailure(
    input: Readonly<{
      name: string;
      script: string;
      runnerOptions?: TerminalRunnerOptions;
      sourceEnv?: NodeJS.ProcessEnv;
      abortAfterOutput?: string;
      onApprovalNeeded?: Parameters<typeof beginDeclaredArtifactReview>[0]['onApprovalNeeded'];
    }>,
  ): Promise<Readonly<{ approvalRequests: number; output: string[]; failure: unknown }>> {
    const { projectDir, stateDir } = testProject(`configured-direct-terminal-${input.name}`);
    let stagePath = '';
    let stageCleanupCalls = 0;
    let leaseDisposeCalls = 0;
    let approvalRequests = 0;
    const output: string[] = [];
    const onApprovalNeeded =
      input.onApprovalNeeded ??
      (async () => {
        approvalRequests += 1;
        return { approved: true as const };
      });
    const planner = await createPreparedPlanner(
      terminalRunner(input.name, input.script, input.runnerOptions),
      runtimeFor({
        projectDir,
        stateDir,
        ...(input.sourceEnv === undefined ? {} : { sourceEnv: input.sourceEnv }),
        createStage: async (sourceProjectDir) => {
          const stage = await createStagedProject(sourceProjectDir);
          stagePath = stage.projectDir;
          return {
            ...stage,
            cleanup: () => {
              stageCleanupCalls += 1;
              stage.cleanup();
            },
          };
        },
        beginDeclaredArtifactReview: async (artifactInput) => {
          const prepared = await beginDeclaredArtifactReview({
            ...artifactInput,
            projectDir,
            sessionId: 'planner-adapter-session',
            onApprovalNeeded,
          });
          return {
            reviewAfterChild: () => prepared.reviewAfterChild(),
            dispose: async () => {
              leaseDisposeCalls += 1;
              await prepared.dispose();
            },
          };
        },
      }),
    );
    const controller = input.abortAfterOutput === undefined ? undefined : new AbortController();
    let resolveChildStarted: (() => void) | undefined;
    const childStarted =
      input.abortAfterOutput === undefined
        ? undefined
        : new Promise<void>((resolve) => {
            resolveChildStarted = resolve;
          });
    const result = planner.review('review this', projectDir, {
      onOutput: (text) => {
        output.push(text);
        if (input.abortAfterOutput !== undefined && text.includes(input.abortAfterOutput)) {
          resolveChildStarted?.();
        }
      },
      ...(controller === undefined ? {} : { signal: controller.signal }),
    });

    if (childStarted !== undefined) {
      const stageState = () =>
        stagePath.length === 0 ? 'not-created' : existsSync(stagePath) ? 'present' : 'removed';
      const readiness = await Promise.race([
        childStarted.then(() => ({ kind: 'child-output' as const })),
        result.then(
          () => ({ kind: 'review-resolved' as const, stage: stageState() }),
          () => ({ kind: 'review-rejected' as const, stage: stageState() }),
        ),
      ]);

      expect(readiness).toEqual({ kind: 'child-output' });
      expect(stagePath).not.toBe('');
      expect(existsSync(stagePath)).toBe(true);
      controller?.abort();
    }

    let failure: unknown;
    try {
      await result;
    } catch (err) {
      failure = err;
    }

    expect(failure).toBeDefined();
    expect(stagePath).not.toBe('');
    expect(stageCleanupCalls).toBe(1);
    expect(leaseDisposeCalls).toBe(1);
    expect(existsSync(stagePath)).toBe(false);
    expect(existsSync(join(projectDir, '.splitbrief-runner'))).toBe(false);
    expect(existsSync(reviewCandidateRoot(projectDir))).toBe(false);

    return { approvalRequests, output, failure };
  }

  const terminalSecret = 'direct-terminal-secret-canary';
  const terminalFailureRows = [
    {
      name: 'nonzero',
      script:
        "require('node:fs').writeFileSync('.splitbrief-runner/output/result', 'never promote');process.exit(17);",
    },
    {
      name: 'missing-result',
      script: "require('node:fs').unlinkSync('.splitbrief-runner/output/result');",
    },
    {
      name: 'extra-stage-write',
      script:
        "require('node:fs').writeFileSync('.splitbrief-runner/output/result', 'declared');require('node:fs').writeFileSync('extra-stage-write', 'reject');",
    },
    {
      name: 'idle-timeout',
      script:
        "require('node:fs').writeFileSync('.splitbrief-runner/output/result', 'would be valid');setInterval(() => {}, 1_000);",
      runnerOptions: { idleWarnMs: 10, idleKillMs: 20 },
    },
    {
      name: 'output-limit',
      script:
        "require('node:fs').writeFileSync('.splitbrief-runner/output/result', 'would be valid');process.stdout.write('x'.repeat(1_310_721));",
    },
    {
      name: 'parser-failure',
      script:
        "require('node:fs').writeFileSync('.splitbrief-runner/output/result', 'would be valid');process.stdout.write(JSON.stringify({ type: 'result', is_error: true }) + '\\n');",
      runnerOptions: { outputFormat: 'stream-json' as const },
    },
    {
      name: 'invalid-utf8',
      script:
        "require('node:fs').writeFileSync('.splitbrief-runner/output/result', Buffer.from([0xc3, 0x28]));",
    },
    {
      name: 'declared-secret',
      script:
        "require('node:fs').writeFileSync('.splitbrief-runner/output/result', process.env.DIRECT_TERMINAL_SECRET);",
      runnerOptions: { env: ['DIRECT_TERMINAL_SECRET'] },
      sourceEnv: { DIRECT_TERMINAL_SECRET: terminalSecret },
    },
  ] as const;

  it.each(
    terminalFailureRows,
  )('leaves no approval, promotion, candidate, lease, or stage behind after $name', async (row) => {
    const observed = await expectTerminalFailure(row);
    expect(observed.approvalRequests).toBe(0);
    expect(observed.output).toEqual([]);
    expect(JSON.stringify(observed.failure)).not.toContain(terminalSecret);
  });

  it('cleans the direct lease and stage when the caller aborts after child start', async () => {
    const observed = await expectTerminalFailure({
      name: 'abort',
      script: "process.stdout.write('child-started\\n');setInterval(() => {}, 1_000);",
      abortAfterOutput: 'child-started',
    });

    expect(observed.approvalRequests).toBe(0);
    expect(observed.output).toEqual(['child-started\n']);
  });

  it('disposes the direct lease and stage when the explicit approval rejects', async () => {
    let approvalRequests = 0;
    const observed = await expectTerminalFailure({
      name: 'approval-rejected',
      script:
        "require('node:fs').writeFileSync('.splitbrief-runner/output/result', 'reviewed but rejected');",
      onApprovalNeeded: async () => {
        approvalRequests += 1;
        return { approved: false };
      },
    });

    expect(approvalRequests).toBe(1);
    expect(observed.approvalRequests).toBe(0);
    expect(observed.output).toEqual([]);
    expect(observed.failure).toMatchObject({ kind: 'custom-planner-artifact-rejected' });
  });

  it('permits lease and stage cleanup after a real child exceeds the hard deadline', async () => {
    const { projectDir } = testProject('configured-direct-terminal-hard-timeout');
    const stage = await createStagedProject(projectDir);
    let approvalRequests = 0;
    const review = await beginDeclaredArtifactReview({
      stagedProjectDir: stage.projectDir,
      projectDir,
      sessionId: 'planner-adapter-session',
      callId: 'hard-timeout',
      declaredRedactionValues: [],
      onApprovalNeeded: async () => {
        approvalRequests += 1;
        return { approved: true };
      },
    });

    try {
      const observation = await observeCustomInvocation(
        {
          admission: await admittedCustomRunner(
            projectDir,
            terminalRunner(
              'hard-timeout',
              [
                "require('node:fs').writeFileSync('.splitbrief-runner/output/result', 'would be valid');",
                'setInterval(() => {}, 1_000);',
              ].join(''),
            ),
          ),
          prompt: 'review this',
          authorizationProjectDir: projectDir,
          cwd: stage.projectDir,
          sourceEnv: {},
        },
        undefined,
        { hardDeadlineMs: 50 },
      );

      expect(observation.result).toBeUndefined();
      expect(observation.failure).toMatchObject({ kind: 'command-timeout' });
      expect(observation.callbacks).toEqual({ output: [], stderr: [], session: [] });
      expect(approvalRequests).toBe(0);
      await review.dispose();
      await expect(review.reviewAfterChild()).rejects.toMatchObject({
        kind: 'custom-planner-artifact-review-disposed',
      });
    } finally {
      await review.dispose();
      stage.cleanup();
    }

    expect(existsSync(stage.projectDir)).toBe(false);
    expect(existsSync(reviewCandidateRoot(projectDir))).toBe(false);
  });
});
