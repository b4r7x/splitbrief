import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { useTrustHome } from '#testing/helpers/trust-home.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { CONFIRM_PHRASE } from '../../../core/approval/types.js';
import { normalizeCustomCommand } from '../../../core/config/custom-commands.js';
import { transition } from '../../../core/state/machine.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeNoValidationConfig } from '#testing/helpers/factories/config.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import {
  makeCallbacks,
  makePlanner,
  makeImplementer,
  makeBusRecorder,
  makeWctx,
} from '#testing/helpers/orchestrator-factories.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { setupGitSessionProject } from '#testing/helpers/git-session.js';
import {
  customRunnerSecurityPosture,
  type ConfiguredCustomRunner,
} from '../../runners/custom-trust.js';
import { prepareCustomRunnerAdmission } from '../../runners/custom-admission.js';
import type { RunnerGate } from '../../runners/prepared-execution.js';
import type { CustomRunnerRuntimePort } from '../../runners/types.js';
import { createConfiguredCustomPlanner } from '../../planners/command-invoke.js';
import { cleanupStaleArtifactReviews } from '../approval/planner-artifact.js';
import { SPLITBRIEF_DIR } from '../../../core/paths.js';
import { handleRetryAndEscalation } from './handle.js';
import type { HooksConfig } from '../../../core/schemas/hooks.js';
import { markHooksConfigTrusted } from '../../../core/hooks/trust.js';

// The hint and full tiers acquire from the run isolation handle; on the copying
// strategy under parallel full-suite load that staged-copy IO can push these
// cases past the 10s default, so widen the timeout for this file (cases pass
// in ~8-25s in isolation).
vi.setConfig({ testTimeout: 60_000 });

let dirs: string[] = [];
let trustHome: ReturnType<typeof useTrustHome>;

beforeEach(() => {
  trustHome = useTrustHome('escalation-handle-trust-home');
});

afterEach(() => {
  for (const d of dirs) cleanupTempDir(d);
  dirs = [];
  trustHome.restore();
});

function setupProject(): { projectDir: string; sessionId: string } {
  const { projectDir, sessionId } = setupGitSessionProject({
    prefix: 'escalation-test',
    sessionId: 'sess-esc',
  });
  dirs.push(projectDir);
  return { projectDir, sessionId };
}

function makeValidatingState(): WorkflowState {
  const task = makeTask();
  let state = makeImplState([task]);
  state = transition(state, { type: 'TASK_SENT' });
  return state;
}

// Validation disabled so runValidationWithEvents returns [] → treated as all-pass.
// Commit strategy 'none' so we don't need a dirty repo for every happy-path test.
const defaultWorkflow = { maxRetries: 2 as const };

describe('handleRetryAndEscalation', () => {
  it('retry succeeds on attempt 1 → completed with method=local', async () => {
    const { projectDir, sessionId } = setupProject();
    const { callbacks } = makeCallbacks();
    const planner = makePlanner();
    const task = makeTask();
    const state = makeValidatingState();
    const implementer = makeImplementer(); // default retry returns success

    const { result } = await handleRetryAndEscalation({
      wctx: makeWctx({
        projectDir,
        sessionId,
        config: makeNoValidationConfig({ workflow: defaultWorkflow }),
        planner,
        callbacks,
        implementer,
        bus: makeBusRecorder().bus,
      }),
      task,
      initialError: 'type error',
      currentState: state,
    });

    expect(result.completed).toBe(true);
    expect(result.method).toBe('local');
  });

  it('all local retries fail → hint retry also fails → result not completed', async () => {
    const { projectDir, sessionId } = setupProject();
    const { callbacks } = makeCallbacks();
    const { bus, events: busEvents } = makeBusRecorder();
    const task = makeTask();
    const state = makeValidatingState();

    // Both local retry attempts AND the hint-tier retry fail: no success anywhere.
    const implementer = makeImplementer({
      retry: vi.fn().mockResolvedValue({
        success: false,
        output: '',
        error: 'still broken',
        usage: { inputTokens: 10, outputTokens: 5 },
      }),
    });

    const planner = makePlanner({
      escalateHint: vi.fn().mockResolvedValue({
        success: true,
        output: 'use x',
        code: null,
        usage: { inputTokens: 50, outputTokens: 25 },
      }),
      escalateFull: vi
        .fn()
        .mockResolvedValue({ success: false, output: '', code: null, usage: null }),
    });

    const { result } = await handleRetryAndEscalation({
      wctx: makeWctx({
        projectDir,
        sessionId,
        config: makeNoValidationConfig({ workflow: { maxRetries: 1 } }),
        planner,
        callbacks,
        implementer,
        bus,
      }),
      task,
      initialError: 'error',
      currentState: state,
    });

    // Local retries exhausted → hint tier → full tier → all failed.
    expect(result.completed).toBe(false);
    const escalateTier1 = busEvents.find((e) => e.type === 'escalate' && e.tier === 1);
    const escalateTier2 = busEvents.find((e) => e.type === 'escalate' && e.tier === 2);
    expect(escalateTier1).toBeDefined();
    expect(escalateTier2).toBeDefined();
  });

  it('runs tier-1 hint escalation with a staged projectDir and sandbox env', async () => {
    const { projectDir, sessionId } = setupProject();
    const { callbacks } = makeCallbacks();
    const { bus } = makeBusRecorder();
    const task = makeTask();
    const state = makeValidatingState();

    const implementer = makeImplementer({
      retry: vi.fn().mockResolvedValue({
        success: false,
        output: '',
        error: 'still broken',
        usage: { inputTokens: 10, outputTokens: 5 },
      }),
    });

    const escalateHint = vi.fn().mockImplementation(async (opts) => {
      expect(opts.projectDir).not.toBe(projectDir);
      expect(opts.fileIgnoreProjectDir).toBe(projectDir);
      // The env belongs to the staged directory. TMPDIR is the invariant to
      // assert: HOME is the host's for a channel whose credential is an OS
      // keychain item, which is what a macOS Claude Code planner uses.
      expect(opts.sandboxEnv?.TMPDIR?.startsWith(opts.projectDir)).toBe(true);
      return { success: false, output: 'hint text', code: null, usage: null };
    });

    const planner = makePlanner({
      escalateHint,
      escalateFull: vi
        .fn()
        .mockResolvedValue({ success: false, output: '', code: null, usage: null }),
    });

    await handleRetryAndEscalation({
      wctx: makeWctx({
        projectDir,
        sessionId,
        config: makeNoValidationConfig({ workflow: { maxRetries: 1 } }),
        planner,
        callbacks,
        implementer,
        bus,
      }),
      task,
      initialError: 'error',
      currentState: state,
    });

    expect(escalateHint).toHaveBeenCalled();
  });

  it('hint-assisted retry succeeds → completed with method=escalated-hint', async () => {
    const { projectDir, sessionId } = setupProject();
    const { callbacks } = makeCallbacks();
    const { bus, events: busEvents } = makeBusRecorder();
    const task = makeTask();
    const state = makeValidatingState();

    const implementer = makeImplementer({
      retry: vi
        .fn()
        // Local retry fails (attempt 1).
        .mockResolvedValueOnce({
          success: false,
          output: '',
          error: 'fail',
          usage: { inputTokens: 10, outputTokens: 5 },
        })
        // Hint-assisted retry succeeds.
        .mockResolvedValueOnce({
          success: true,
          output: 'fixed',
          usage: { inputTokens: 20, outputTokens: 10 },
        }),
    });

    const planner = makePlanner({
      escalateHint: vi.fn().mockResolvedValue({
        success: true,
        output: 'try adding import',
        code: null,
        usage: { inputTokens: 100, outputTokens: 50 },
      }),
    });

    const { result } = await handleRetryAndEscalation({
      wctx: makeWctx({
        projectDir,
        sessionId,
        config: makeNoValidationConfig({ workflow: { maxRetries: 1 } }),
        planner,
        callbacks,
        implementer,
        bus,
      }),
      task,
      initialError: 'error',
      currentState: state,
    });

    expect(result.completed).toBe(true);
    expect(result.method).toBe('escalated-hint');
    expect(busEvents.find((e) => e.type === 'escalate' && e.tier === 1)).toBeDefined();
  });

  it('retry promotion conflicts ask for user-edit resolution and do not escalate', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({
      id: 'T001',
      file: 'src/main.ts',
      action: 'modify',
      scope: { inBounds: ['src/main.ts'] },
    });
    const state: WorkflowState = { ...makeValidatingState(), tasks: [task] };
    const onUserEditConflict = vi.fn().mockResolvedValue('pause');
    const { callbacks } = makeCallbacks({
      onTieredApproval: vi.fn().mockImplementation(async () => {
        mkdirSync(join(projectDir, 'src'), { recursive: true });
        writeFileSync(join(projectDir, 'src/other.ts'), 'export const value = "user";\n');
        return { decision: 'allow', scope: 'once' };
      }),
      onUserEditConflict,
    });
    const { bus, events: busEvents } = makeBusRecorder();

    const implementer = makeImplementer({
      retry: vi.fn().mockImplementation(async ({ projectDir: runDir }: { projectDir: string }) => {
        mkdirSync(join(runDir, 'src'), { recursive: true });
        writeFileSync(join(runDir, 'src/other.ts'), 'export const value = "retry";\n');
        return { success: true, output: 'fixed', usage: { inputTokens: 20, outputTokens: 10 } };
      }),
    });
    const planner = makePlanner({
      escalateHint: vi
        .fn()
        .mockResolvedValue({ success: true, output: 'hint', code: null, usage: null }),
    });

    const { result, state: finalState } = await handleRetryAndEscalation({
      wctx: makeWctx({
        projectDir,
        sessionId,
        config: makeNoValidationConfig({
          workflow: { maxRetries: 1 },
          approval: { enabled: true, feedRejectionsToPlanner: false },
        }),
        planner,
        callbacks,
        implementer,
        bus,
      }),
      task,
      initialError: 'validation failed',
      currentState: state,
    });

    expect(result.completed).toBe(false);
    expect(onUserEditConflict).not.toHaveBeenCalled();
    expect(finalState.pendingRecovery).toMatchObject({
      reason: 'approval-promotion-conflict',
      taskId: 'T001',
      files: ['src/other.ts'],
    });
    expect(busEvents.find((event) => event.type === 'paused_external_changes')).toMatchObject({
      type: 'paused_external_changes',
      selectedAction: 'pause',
      conflict: {
        kind: 'changed-during-approval-promotion',
        files: ['src/other.ts'],
      },
    });
  });

  it('Tier 2 full escalation: planner.escalateFull succeeds → completed with method=escalated-full', async () => {
    const { projectDir, sessionId } = setupProject();
    const { callbacks } = makeCallbacks();
    const { bus, events: busEvents } = makeBusRecorder();
    const task = makeTask();
    const state = makeValidatingState();

    const implementer = makeImplementer({
      retry: vi.fn().mockResolvedValue({
        success: false,
        output: '',
        error: 'fail',
        usage: { inputTokens: 10, outputTokens: 5 },
      }),
    });

    const escalateFull = vi.fn().mockImplementation(async (opts) => {
      expect(opts.projectDir).not.toBe(projectDir);
      expect(opts.fileIgnoreProjectDir).toBe(projectDir);
      // The env belongs to the staged directory. TMPDIR is the invariant to
      // assert: HOME is the host's for a channel whose credential is an OS
      // keychain item, which is what a macOS Claude Code planner uses.
      expect(opts.sandboxEnv?.TMPDIR?.startsWith(opts.projectDir)).toBe(true);
      const taskPath = join(opts.projectDir, task.file);
      mkdirSync(dirname(taskPath), { recursive: true });
      writeFileSync(taskPath, 'export const hello = "world";\n');
      return {
        success: true,
        output: 'full code',
        code: 'code',
        usage: { inputTokens: 200, outputTokens: 100 },
      };
    });

    const planner = makePlanner({
      escalateHint: vi.fn().mockResolvedValue({
        success: true,
        output: 'hint',
        code: null,
        usage: { inputTokens: 50, outputTokens: 25 },
      }),
      escalateFull,
    });

    const { result } = await handleRetryAndEscalation({
      wctx: makeWctx({
        projectDir,
        sessionId,
        config: makeNoValidationConfig({ workflow: { maxRetries: 1 } }),
        planner,
        callbacks,
        implementer,
        bus,
      }),
      task,
      initialError: 'error',
      currentState: state,
    });

    expect(escalateFull).toHaveBeenCalled();
    expect(result.completed).toBe(true);
    expect(result.method).toBe('escalated-full');
    expect(busEvents.find((e) => e.type === 'escalate' && e.tier === 2)).toBeDefined();
  });

  it('discards a successful staged retry without promotion when the workflow aborts after invoke', async () => {
    const { projectDir, sessionId } = setupProject();
    const targetPath = join(projectDir, 'src', 'signal.ts');
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(targetPath, 'original\n');
    const task = makeTask({ id: 'T012', file: 'src/signal.ts' });
    const state: WorkflowState = { ...makeValidatingState(), tasks: [task] };
    const { callbacks } = makeCallbacks();
    const { bus, events: busEvents } = makeBusRecorder();
    const controller = new AbortController();

    let retryEntered: () => void;
    const retryEnteredPromise = new Promise<void>((resolve) => {
      retryEntered = resolve;
    });

    const implementer = makeImplementer({
      retry: vi
        .fn()
        .mockImplementation(
          async ({ projectDir: runDir, signal }: { projectDir: string; signal?: AbortSignal }) => {
            mkdirSync(join(runDir, 'src'), { recursive: true });
            writeFileSync(join(runDir, 'src', 'signal.ts'), 'staged mutation\n');
            retryEntered();
            await new Promise<void>((resolve) => {
              if (signal?.aborted) {
                resolve();
                return;
              }
              signal?.addEventListener('abort', () => resolve(), { once: true });
            });
            return {
              success: true,
              output: 'fixed',
              usage: { inputTokens: 12, outputTokens: 6 },
            };
          },
        ),
    });

    const run = handleRetryAndEscalation({
      wctx: makeWctx({
        projectDir,
        sessionId,
        config: makeNoValidationConfig({ workflow: { maxRetries: 1 } }),
        planner: makePlanner(),
        callbacks,
        implementer,
        bus,
        signal: controller.signal,
      }),
      task,
      initialError: 'validation failed',
      currentState: state,
    });

    await retryEnteredPromise;
    controller.abort();
    const { result } = await run;

    expect(result.completed).toBe(false);
    expect(readFileSync(targetPath, 'utf-8')).toBe('original\n');
    expect(busEvents.find((e) => e.type === 'task_completed')).toBeUndefined();
  });

  it('full escalation fails without advancing the task in the retry pipeline', async () => {
    const { projectDir, sessionId } = setupProject();
    // Create a dirty file so a failed full escalation has real worktree state to leave untouched.
    writeFileSync(join(projectDir, 'task-file.ts'), 'pending content');
    const task = makeTask({ file: 'task-file.ts', action: 'create' });
    const state = makeValidatingState();
    // Update task list with the file-matching task so shutdown cleanup finds a real path.
    const stateWithTask: WorkflowState = {
      ...state,
      tasks: [task],
    };

    const { callbacks } = makeCallbacks();
    const implementer = makeImplementer({
      retry: vi.fn().mockResolvedValue({
        success: false,
        output: '',
        error: 'fail',
        usage: { inputTokens: 10, outputTokens: 5 },
      }),
    });

    const planner = makePlanner({
      escalateHint: vi
        .fn()
        .mockResolvedValue({ success: true, output: 'hint', code: null, usage: null }),
      escalateFull: vi
        .fn()
        .mockResolvedValue({ success: false, output: '', code: null, usage: null }),
    });

    const { result, state: finalState } = await handleRetryAndEscalation({
      wctx: makeWctx({
        projectDir,
        sessionId,
        config: makeNoValidationConfig({ workflow: { maxRetries: 1 } }),
        planner,
        callbacks,
        implementer,
        bus: makeBusRecorder().bus,
      }),
      task,
      initialError: 'error',
      currentState: stateWithTask,
    });

    expect(result.completed).toBe(false);
    expect(result.method).toBe('failed');
    expect(finalState.currentTaskIndex).toBe(0);
    expect(finalState.tasks[0]?.status).toBe('pending');
  });

  it('runs configured direct full escalation in the outer stage and only promotes an approved diff', async () => {
    const scenarios = [
      {
        name: 'approved',
        response: {
          decision: 'confirm',
          phrase: CONFIRM_PHRASE,
          reason: 'reviewed full diff',
        } as const,
        promoted: true,
      },
      {
        name: 'rejected',
        response: { decision: 'deny', reason: 'do not promote' } as const,
        promoted: false,
      },
    ];

    for (const scenario of scenarios) {
      const { projectDir, sessionId } = setupProject();
      const stateDir = createTempDir(`t028-full-${scenario.name}-state`);
      const outsideDir = createTempDir(`t028-full-${scenario.name}-outside`);
      dirs.push(stateDir, outsideDir);
      const outsideSentinel = join(outsideDir, 'child-can-reach-host');
      const task = makeTask({
        id: 'T028',
        file: 'src/escalated.ts',
        action: 'create',
        scope: { inBounds: ['src/escalated.ts'] },
      });
      const state: WorkflowState = { ...makeValidatingState(), tasks: [task] };
      let nestedStageCalls = 0;
      const program = [
        "const fs = require('node:fs');",
        "const prompt = fs.readFileSync(0, 'utf8');",
        `const sourceProject = ${JSON.stringify(projectDir)};`,
        "fs.mkdirSync('src', { recursive: true });",
        `fs.writeFileSync(${JSON.stringify(outsideSentinel)}, 'outside-stage-reachable');`,
        'const lines = [',
        "  '// outer-stage:' + (process.cwd() !== sourceProject),",
        "  '// allowed:' + (process.env.T028_ALLOWED_VALUE ?? 'absent'),",
        "  '// undeclared:' + (process.env.T028_UNDECLARED_SECRET ?? 'absent'),",
        "  '// session-in-prompt:' + prompt.includes('t028-session-must-not-reach-child'),",
        "  'export const escalated = true;',",
        '];',
        "fs.writeFileSync('src/escalated.ts', lines.join('\\n') + '\\n');",
      ].join('');
      const runner: ConfiguredCustomRunner = {
        source: 'configured',
        command: normalizeCustomCommand(`t028-full-${scenario.name}`, {
          label: `T028 full ${scenario.name}`,
          contract: 'direct',
          executable: process.execPath,
          argv: ['-e', program],
          env: ['T028_ALLOWED_VALUE'],
        }),
      };
      const staleReviewRoot = join(
        projectDir,
        SPLITBRIEF_DIR,
        'sessions',
        't028-session-must-not-reach-child',
        '.custom-runner-review',
      );
      const stalePath = join(staleReviewRoot, 'stale-call', 'result');
      mkdirSync(join(staleReviewRoot, 'stale-call'), { recursive: true });
      writeFileSync(stalePath, 'stale');
      const runtime: CustomRunnerRuntimePort = {
        sessionId: 't028-session-must-not-reach-child',
        authorizationProjectDir: projectDir,
        sourceEnv: {
          T028_ALLOWED_VALUE: 'runtime-source-only',
          T028_UNDECLARED_SECRET: 'must-not-reach-child',
        },
        authorizationPathEnv: process.env.PATH ?? '',
        ...(process.env.PATHEXT === undefined ? {} : { authorizationPathExt: process.env.PATHEXT }),
        createStage: async () => {
          nestedStageCalls += 1;
          throw new Error('Direct full escalation must use the retry outer stage');
        },
        admission: { interaction: 'headless', allowRepoRunners: true, stateDir },
        cleanupStaleArtifactReviews: () =>
          cleanupStaleArtifactReviews({
            projectDir,
            sessionId: 't028-session-must-not-reach-child',
          }),
        beginDeclaredArtifactReview: async () => {
          throw new Error('Direct full escalation must not begin planner artifact review.');
        },
      };
      const admission = await prepareCustomRunnerAdmission({
        ...runtime.admission,
        projectDir,
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
        preparationId: 'escalation-direct-planner',
        command: { kind: 'configured-custom', invocation: admission.invocation },
      } satisfies RunnerGate;
      const planner = createConfiguredCustomPlanner(runner, runtime, gate.command.invocation);
      const implementer = makeImplementer({
        retry: vi.fn().mockResolvedValue({
          success: false,
          output: '',
          error: 'still broken',
          usage: { inputTokens: 1, outputTokens: 1 },
        }),
      });
      const { callbacks } = makeCallbacks({
        onTieredApproval: vi.fn().mockResolvedValue(scenario.response),
      });
      const { bus } = makeBusRecorder();

      const { result } = await handleRetryAndEscalation({
        wctx: makeWctx({
          projectDir,
          sessionId,
          config: makeNoValidationConfig({
            workflow: { maxRetries: 1 },
            approval: {
              enabled: true,
              feedRejectionsToPlanner: true,
              tiers: { write_in_scope: 'confirm' },
            },
          }),
          planner,
          callbacks,
          implementer,
          bus,
        }),
        task,
        initialError: 'validation failed',
        currentState: state,
      });

      expect(nestedStageCalls).toBe(0);
      expect(existsSync(stalePath)).toBe(false);
      expect(existsSync(staleReviewRoot)).toBe(false);
      expect(result.completed).toBe(scenario.promoted);
      expect(result.method).toBe(scenario.promoted ? 'escalated-full' : 'failed');
      expect(readFileSync(outsideSentinel, 'utf8')).toBe('outside-stage-reachable');
      expect(existsSync(join(projectDir, 'src', 'escalated.ts'))).toBe(scenario.promoted);
      if (scenario.promoted) {
        const promoted = readFileSync(join(projectDir, 'src', 'escalated.ts'), 'utf8');
        expect(promoted).toContain('// outer-stage:true');
        expect(promoted).toContain('// allowed:runtime-source-only');
        expect(promoted).toContain('// undeclared:absent');
        expect(promoted).toContain('// session-in-prompt:false');
        expect(promoted).not.toContain(projectDir);
      }
    }
  });

  it('pre_escalation deny raises a hook-named recovery instead of a generic retry-exhausted one', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({ id: 'T001' });
    const state: WorkflowState = { ...makeValidatingState(), tasks: [task] };
    writeFileSync(
      join(projectDir, 'deny-escalation.mjs'),
      [
        'export default function () {',
        "  return { kind: 'deny', message: 'policy: escalation not allowed' };",
        '}',
      ].join('\n'),
    );

    const { callbacks } = makeCallbacks();
    const { bus, events: busEvents } = makeBusRecorder();
    const escalateHint = vi.fn();
    const escalateFull = vi.fn();
    const implementer = makeImplementer({
      retry: vi.fn().mockResolvedValue({
        success: false,
        output: '',
        error: 'still broken',
        usage: { inputTokens: 10, outputTokens: 5 },
      }),
    });
    const planner = makePlanner({ escalateHint, escalateFull });
    const hooks: HooksConfig = {
      pre_escalation: [
        {
          kind: 'module',
          path: 'deny-escalation.mjs',
          timeout_ms: 30_000,
          on_failure: 'warn',
        },
      ],
    };
    markHooksConfigTrusted(projectDir, hooks);

    const { result, state: finalState } = await handleRetryAndEscalation({
      wctx: makeWctx({
        projectDir,
        sessionId,
        config: makeNoValidationConfig({
          workflow: { maxRetries: 1 },
          hooks,
        }),
        planner,
        callbacks,
        implementer,
        bus,
      }),
      task,
      initialError: 'type error',
      currentState: state,
    });

    expect(result.completed).toBe(false);
    // Escalation tiers must never run once the hook denies.
    expect(escalateHint).not.toHaveBeenCalled();
    expect(escalateFull).not.toHaveBeenCalled();
    expect(busEvents.find((e) => e.type === 'escalate')).toBeUndefined();

    // The recovery is attributed to the hook, not silently mislabeled as retry exhaustion.
    expect(finalState.pendingRecovery).toMatchObject({
      reason: 'retry-exhausted',
      taskId: 'T001',
    });
    expect(finalState.pendingRecovery?.message).toContain('pre_escalation hook');
    expect(finalState.pendingRecovery?.message).toContain('policy: escalation not allowed');
    expect(finalState.pendingRecovery?.message).not.toContain('exhausted recovery retries');
    expect(busEvents.find((e) => e.type === 'recovery_prompted')).toMatchObject({
      type: 'recovery_prompted',
      reason: 'retry-exhausted',
    });
  });
});
