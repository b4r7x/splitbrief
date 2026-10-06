import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isolationWorktreePath } from '../../../src/core/paths.js';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CliImplementerConfig } from '../../../src/core/schemas/implementer-config.js';
import type { Config } from '../../../src/core/schemas/config.js';
import type { WorkflowState } from '../../../src/core/schemas/workflow.js';
import { loadState } from '../../../src/core/state/persistence.js';
import { ensureSessionDir } from '../../../src/core/paths-io.js';
import type { EngineEvent } from '../../../src/engine/events/types.js';
import { createChangeDetector } from '../../../src/engine/change-detection.js';
import { createCliImplementer } from '../../../src/engine/implementers/cli.js';
import { createImplementerBase } from '../../../src/engine/implementers/pipeline/run.js';
import type { ImplementerPublisher, InvokeOpts } from '../../../src/engine/implementers/types.js';
import { createImplementerPublisher } from '../../../src/engine/orchestrator/events.js';
import { applyRecoveryAction } from '../../../src/engine/orchestrator/recovery/actions.js';
import { runWorkflow } from '../../../src/engine/orchestrator/run/workflow.js';
import { runTaskLoop } from '../../../src/engine/orchestrator/task/loop.js';
import { createEventBus } from '../../../src/engine/events/bus.js';
import { makeConfig, makeNoValidationConfig } from '#testing/helpers/factories/config.js';
import { makePreparedExecution } from '#testing/helpers/factories/prepared-execution.js';
import { makeRunnerCallResult } from '#testing/helpers/factories/runner-call.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { prependPath, trustedShimGate } from '#testing/helpers/command-shim.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { TEST_WORKFLOW_SINKS } from '#testing/helpers/orchestrator-context.js';
import {
  makeBusRecorder,
  makeCallbacks,
  makePlanner,
  makeWctx,
  makeWorktreeIsolation,
  runWorkspaceDir,
} from '#testing/helpers/orchestrator-factories.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { typedCallFromTasks } from '#testing/helpers/typed-planner.js';

const TARGET = 'src/greet.ts';
const SOURCE = 'export const greet = (name: string): string => name;\n';

const dirs: string[] = [];
const ORIGINAL_XDG_STATE_HOME = process.env.XDG_STATE_HOME;
let restorePath: (() => void) | undefined;

beforeEach(() => {
  resetAllStores();
  const stateHome = createTempDir('isolation-halt-state');
  dirs.push(stateHome);
  process.env.XDG_STATE_HOME = stateHome;
});

afterEach(() => {
  restorePath?.();
  restorePath = undefined;
  if (ORIGINAL_XDG_STATE_HOME === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = ORIGINAL_XDG_STATE_HOME;
  while (dirs.length > 0) cleanupTempDir(dirs.pop() as string);
});

function setupProject(): string {
  const projectDir = createTempDir('isolation-halt-project');
  dirs.push(projectDir);
  createTestGitRepo(projectDir, { '.gitignore': '.splitbrief/\n', 'validate.mjs': 'ok\n' });
  return projectDir;
}

const greetTask = () =>
  makeTask({
    id: 'T001',
    action: 'create',
    suggestedFiles: [TARGET],
    title: 'Add the greeting helper',
    description: 'Create a greeting helper module.',
    implementationSteps: ['Create src/greet.ts exporting greet.'],
    tests: ['greet("a") returns "hello a"'],
    scope: { inBounds: [TARGET], outOfBounds: ['everything else'] },
    evidence: ['src/greet.ts exports greet'],
    typeDefs: 'export const greet: (name: string) => string',
  });

function opencodeConfig(): CliImplementerConfig {
  return {
    kind: 'cli',
    tool: 'opencode',
    authChannel: 'provider-dependent',
    model: 'opencode/test-isolation',
    contextLength: 4096,
  };
}

const OPENCODE_STREAM = join(import.meta.dirname, '../../fixtures/opencode/stream-json.ndjson');

/**
 * An opencode build whose first run announces a shell call writing into the checkout,
 * then keeps running: only the guard ends it before the minute is up. Every later
 * run writes the brief's file where it was started and ends on the captured
 * stream of a completed opencode run.
 */
function installEscapingOpencodeShim(checkoutFile: string): void {
  const shimDir = createTempDir('isolation-halt-shim');
  dirs.push(shimDir);
  const toolUse = JSON.stringify({
    type: 'tool_use',
    sessionID: 'ses_isolation',
    part: {
      type: 'tool',
      callID: 'call_1',
      tool: 'bash',
      state: { status: 'running', input: { command: `printf x > ${checkoutFile}` } },
    },
  });
  writeFileSync(
    join(shimDir, 'opencode'),
    [
      '#!/bin/bash',
      `SHIM='${shimDir}'`,
      'if [[ " $* " == *" --version "* ]]; then echo "opencode 1.18.15"; exit 0; fi',
      'if [ -f "$SHIM/ran" ]; then',
      '  mkdir -p src',
      `  printf '%s' '${SOURCE}' > "$PWD/${TARGET}"`,
      `  cat '${OPENCODE_STREAM}'`,
      '  exit 0',
      'fi',
      'touch "$SHIM/ran"',
      `printf '%s\\n' '${toolUse}'`,
      'sleep 60',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  restorePath = prependPath(shimDir);
  shimGates.push(trustedShimGate({ dir: shimDir, tool: 'opencode' }));
}

const shimGates: ReturnType<typeof trustedShimGate>[] = [];

describe('isolation halt through the orchestrator', { timeout: 90_000 }, () => {
  it('stops a CLI implementer at a tool call into the checkout, halts the brief, and a retry finishes it', async () => {
    const projectDir = setupProject();
    const sessionId = 'sess-isolation-tripwire';
    ensureSessionDir(projectDir, sessionId);
    const checkoutFile = join(projectDir, 'validate.mjs');
    installEscapingOpencodeShim(checkoutFile);
    const config: Config = makeNoValidationConfig({
      implementer: opencodeConfig(),
      workflow: { maxRetries: 2 },
    });
    const { bus, events } = makeBusRecorder();
    const taskLoop = (initialState: WorkflowState) =>
      runTaskLoop({
        wctx: makeWctx({
          projectDir,
          sessionId,
          bus,
          config,
          isolation: makeWorktreeIsolation({ projectDir, sessionId }),
          implementer: createCliImplementer(opencodeConfig(), {
            trustedCli: shimGates.at(-1),
          }),
        }),
        initialState,
        setTrackedState: vi.fn(),
        setCurrentTask: vi.fn(),
      });
    const started = Date.now();

    const { state } = await taskLoop(makeImplState([greetTask()]));

    expect(Date.now() - started).toBeLessThan(45_000);
    expect(state.pendingRecovery).toMatchObject({
      reason: 'implementer-left-isolation',
      taskId: 'T001',
      message: `T001 left the isolation directory — OpenCode CLI wrote to ${checkoutFile} (your checkout) with bash: printf x > ${checkoutFile}`,
      availableActions: ['retry-same-worker', 'skip-current-task', 'end-run'],
      recommendedAction: 'retry-same-worker',
    });
    expect(state.pendingRecovery?.details).toEqual([
      `OpenCode CLI wrote to ${checkoutFile} (your checkout) with bash: printf x > ${checkoutFile}`,
      "Your checkout gets the run's changes only through Apply.",
      'Worker profile: default',
    ]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'recovery_prompted',
        reason: 'implementer-left-isolation',
        headline: 'T001 left the isolation directory',
      }),
    );
    expect(events.some((event) => event.type === 'task_retry')).toBe(false);

    const retried = await applyRecoveryAction({
      projectDir,
      sessionId,
      state,
      action: 'retry-same-worker',
      bus: createEventBus(),
      config,
    });
    expect(retried).toMatchObject({ ok: true, status: 'retry-current-task' });

    const finished = await taskLoop(retried.state);

    expect(finished.state.pendingRecovery).toBeUndefined();
    expect(finished.state.tasks[0]?.status).toBe('done');
    expect(
      readFileSync(
        join(isolationWorktreePath(join(realpathSync(projectDir), '.git'), sessionId), TARGET),
        'utf8',
      ),
    ).toBe(SOURCE);
    expect(existsSync(join(projectDir, TARGET))).toBe(false);
  });

  describe('a direct writer that changes the checkout', () => {
    const planner = () =>
      makePlanner({
        typedCall: typedCallFromTasks([greetTask()]),
        review: vi.fn().mockResolvedValue({
          text: '# Final review\n\n### Verdict\npass',
          usage: { inputTokens: 1, outputTokens: 1 },
        }),
      });

    const addBranch = (checkoutDir: string) =>
      execSync('git branch escaped', { cwd: checkoutDir, stdio: 'pipe' });

    /** The first attempt also changes the checkout; every later one stays put. */
    function escapingOnceImplementer(input: {
      calls: InvokeOpts[];
      changeCheckout: (checkoutDir: string) => void;
      publisher: ImplementerPublisher | undefined;
    }) {
      const { calls, changeCheckout } = input;
      return createImplementerBase({
        extractsCode: false,
        backendKind: 'agent',
        detectChanges: createChangeDetector('fixture agent'),
        publisher: input.publisher,
        invoke: async (opts) => {
          calls.push(opts);
          mkdirSync(join(opts.projectDir, 'src'), { recursive: true });
          writeFileSync(join(opts.projectDir, TARGET), SOURCE);
          if (calls.length === 1 && opts.checkoutDir !== undefined)
            changeCheckout(opts.checkoutDir);
          return makeRunnerCallResult({ status: 'completed', text: 'done', usage: null });
        },
      });
    }

    const agentConfig = (): Config =>
      makeConfig({
        implementer: {
          kind: 'agent',
          command: 'node',
          model: 'fixture-agent',
          contextLength: 4096,
        },
        validation: { typecheck: false, lint: false, test: false },
        workflow: { approve: 'none', maxRetries: 2 },
      });

    async function run(input: {
      projectDir: string;
      sessionId: string;
      calls: InvokeOpts[];
      events: EngineEvent[];
      changeCheckout?: ((checkoutDir: string) => void) | undefined;
      publisher?: ImplementerPublisher | undefined;
      resumeState?: WorkflowState | undefined;
    }) {
      const config = agentConfig();
      await runWorkflow({
        prepared: makePreparedExecution({
          projectDir: input.projectDir,
          sessionId: input.sessionId,
          feature: 'add a greeting helper',
          config,
          ...(input.resumeState !== undefined && { resumeState: input.resumeState }),
        }),
        callbacks: makeCallbacks().callbacks,
        sinks: TEST_WORKFLOW_SINKS,
        _planner: planner(),
        _implementer: escapingOnceImplementer({
          calls: input.calls,
          changeCheckout: input.changeCheckout ?? addBranch,
          publisher: input.publisher,
        }),
        _eventSink: (event) => input.events.push(event),
        ...(input.resumeState !== undefined && { savedState: input.resumeState }),
      });
      const state = loadState({ projectDir: input.projectDir, sessionId: input.sessionId });
      if (state === null) throw new Error('the run saved no state');
      return state;
    }

    async function haltedRun(projectDir: string, sessionId: string) {
      const calls: InvokeOpts[] = [];
      const events: EngineEvent[] = [];
      const state = await run({ projectDir, sessionId, calls, events });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.checkoutDir).toBe(projectDir);
      expect(state.pendingRecovery).toMatchObject({
        reason: 'checkout-changed',
        taskId: 'T001',
        availableActions: ['retry-same-worker', 'skip-current-task', 'end-run'],
      });
      expect(state.pendingRecovery?.message).toBe(
        'Your checkout changed under T001 — branch escaped',
      );
      // The brief's own file was never promoted: the halt came before the gate.
      expect(existsSync(join(projectDir, TARGET))).toBe(false);
      return { state, calls };
    }

    it('halts on the audit, and a retry replays the brief to completion', async () => {
      const projectDir = setupProject();
      const sessionId = 'sess-isolation-audit-retry';
      const { state, calls } = await haltedRun(projectDir, sessionId);

      const retried = await applyRecoveryAction({
        projectDir,
        sessionId,
        state,
        action: 'retry-same-worker',
        bus: createEventBus(),
        config: agentConfig(),
      });
      expect(retried).toMatchObject({ ok: true, status: 'retry-current-task' });

      const events: EngineEvent[] = [];
      const finished = await run({
        projectDir,
        sessionId,
        calls,
        events,
        resumeState: retried.state,
      });

      expect(calls).toHaveLength(2);
      expect(finished.pendingRecovery).toBeUndefined();
      expect(finished.tasks[0]?.status).toBe('done');
      expect(readFileSync(join(runWorkspaceDir({ projectDir, sessionId }), TARGET), 'utf8')).toBe(
        SOURCE,
      );
      expect(existsSync(join(projectDir, TARGET))).toBe(false);
      expect(events.some((event) => event.type === 'task_completed')).toBe(true);
    });

    it('warns on a file written into the checkout and finishes the brief', async () => {
      const projectDir = setupProject();
      const calls: InvokeOpts[] = [];
      const recorder = makeBusRecorder();

      const finished = await run({
        projectDir,
        sessionId: 'sess-isolation-audit-file',
        calls,
        events: [],
        changeCheckout: (checkoutDir) =>
          writeFileSync(join(checkoutDir, 'escaped.txt'), 'written around promotion\n'),
        publisher: createImplementerPublisher(recorder.bus),
      });

      expect(calls).toHaveLength(1);
      expect(finished.pendingRecovery).toBeUndefined();
      expect(finished.tasks[0]?.status).toBe('done');
      expect(recorder.events).toContainEqual(
        expect.objectContaining({
          type: 'warning',
          taskId: 'T001',
          code: 'checkout_changed_during_call',
          message:
            'Task T001: your checkout changed while agent ran — escaped.txt; nothing there was reverted',
        }),
      );
      expect(existsSync(join(projectDir, 'escaped.txt'))).toBe(true);
    });

    it('skips the halted brief when the operator chooses skip', async () => {
      const projectDir = setupProject();
      const sessionId = 'sess-isolation-audit-skip';
      const { state, calls } = await haltedRun(projectDir, sessionId);

      const skipped = await applyRecoveryAction({
        projectDir,
        sessionId,
        state,
        action: 'skip-current-task',
        bus: createEventBus(),
        config: agentConfig(),
      });
      expect(skipped.ok).toBe(true);

      const events: EngineEvent[] = [];
      const finished = await run({
        projectDir,
        sessionId,
        calls,
        events,
        resumeState: skipped.state,
      });

      expect(calls).toHaveLength(1);
      expect(finished.tasks[0]?.status).toBe('skipped');
      expect(existsSync(join(projectDir, TARGET))).toBe(false);
    });
  });
});
