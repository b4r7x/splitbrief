import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CliAuthChannelId } from '../../core/runners/cli-tool-catalog.js';
import type { CliImplementerConfig } from '../../core/schemas/implementer-config.js';
import { makeConfig, defaultContext } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { prependPath, trustedShimGate } from '#testing/helpers/command-shim.js';
import { callPlanner } from '#testing/helpers/planner-call.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import type { RunnerCallContext, RunnerCallEvent } from '../calls/types.js';
import { createClaudeCodePlanner } from '../planners/claude-code.js';
import { createCliPlanner } from '../planners/cli.js';
import { createCliImplementer } from '../implementers/cli.js';

type Outcome = 'completed' | 'failed' | 'aborted';

const dispatch = vi.hoisted(() => ({
  outcome: 'completed' as Outcome,
  controller: new AbortController(),
  spawns: 0,
  recorders: [] as Array<{ context: RunnerCallContext; events: RunnerCallEvent[] }>,
}));

vi.mock('../calls/recorder.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../calls/recorder.js')>();
  return {
    ...actual,
    createRunnerCallRecorder: (opts: Parameters<typeof actual.createRunnerCallRecorder>[0]) => {
      const events: RunnerCallEvent[] = [];
      const recorder = actual.createRunnerCallRecorder({
        ...opts,
        onEvent: (event) => {
          events.push(event);
          opts.onEvent?.(event);
        },
      });
      dispatch.recorders.push({ context: recorder.context, events });
      return recorder;
    },
  };
});

// A read-only planner call snapshots the project with git; these fixtures are not repositories.
vi.mock('../orchestrator/planning/mutation-guard.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../orchestrator/planning/mutation-guard.js')>();
  return {
    ...actual,
    capturePlanningMutationBaseline: async () => null,
    findUnexpectedPlanningMutations: async () => [],
  };
});

// The generic CLI dispatch seam: one recorder per spawn, finished as scripted.
vi.mock('./cli-tools/process-invoke.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./cli-tools/process-invoke.js')>();
  const { createRunnerCallRecorder } = await import('../calls/recorder.js');
  return {
    ...actual,
    invokeProcessCli: async (
      _adapter: unknown,
      context: Parameters<typeof actual.invokeProcessCli>[1],
    ) => {
      dispatch.spawns += 1;
      const recorder = createRunnerCallRecorder({
        context: context.callContext,
        onEvent: context.onEvent,
      });
      if (dispatch.outcome === 'completed') {
        recorder.text({ channel: 'assistant', text: 'done', semantics: 'final' });
        return recorder.finishCompleted();
      }
      return recorder.finishFailed({
        status: dispatch.outcome,
        error: { code: `scripted_${dispatch.outcome}`, message: `scripted ${dispatch.outcome}` },
      });
    },
  };
});

// The specialized Claude spawn: stream-json lines, a thrown failure, or an abort.
vi.mock('../../lib/process/spawn/line-stream.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/process/spawn/line-stream.js')>();
  return {
    ...actual,
    spawnWithStdin: async (opts: Parameters<typeof actual.spawnWithStdin>[0]) => {
      dispatch.spawns += 1;
      if (dispatch.outcome === 'failed') throw new Error('scripted failed');
      if (dispatch.outcome === 'aborted') {
        dispatch.controller.abort();
        throw Object.assign(new Error('scripted aborted'), { name: 'AbortError' });
      }
      opts.onLine(JSON.stringify({ type: 'result', session_id: 'sess-new', result: 'done' }));
      return { text: '' };
    },
  };
});

let shimDir: string;
let projectDir: string;
let restorePath: () => void;

beforeEach(() => {
  shimDir = createTempDir('invocation-identity-routing-shim');
  projectDir = createTempDir('invocation-identity-routing-project');
  restorePath = prependPath(shimDir);
  dispatch.outcome = 'completed';
  dispatch.controller = new AbortController();
  dispatch.spawns = 0;
  dispatch.recorders.length = 0;
});

afterEach(() => {
  restorePath();
  cleanupTempDir(shimDir);
  cleanupTempDir(projectDir);
});

type Channel = CliAuthChannelId | undefined;

const callbacks = () => ({ onOutput: () => {}, signal: dispatch.controller.signal });

const codexPlanner = (authChannel: Channel) =>
  createCliPlanner({
    config: makeConfig({
      planner: { kind: 'cli', tool: 'codex', ...(authChannel !== undefined && { authChannel }) },
    }),
    trustedCli: trustedShimGate({ dir: shimDir, tool: 'codex' }),
  });

const claudePlanner = (authChannel: Channel) =>
  createClaudeCodePlanner({
    authChannel,
    trustedCli: trustedShimGate({ dir: shimDir, tool: 'claude-code' }),
  });

function build(implementer: CliImplementerConfig) {
  return createCliImplementer(implementer, {
    trustedCli: trustedShimGate({ dir: shimDir, tool: implementer.tool }),
  }).implement({
    task: makeTask(),
    projectDir,
    config: makeConfig({ implementer }),
    context: { ...defaultContext, dir: projectDir },
    ...callbacks(),
  });
}

const ROUTES: ReadonlyArray<{
  name: string;
  tool: string;
  run: (ch: Channel) => Promise<unknown>;
}> = [
  {
    name: 'generic PLAN',
    tool: 'codex',
    run: (ch) => callPlanner(codexPlanner(ch), { projectDir, callbacks: callbacks() }),
  },
  {
    name: 'generic REVIEW',
    tool: 'codex',
    run: (ch) => codexPlanner(ch).review('prompt', projectDir, callbacks()),
  },
  {
    name: 'generic BUILD',
    tool: 'codex',
    run: (ch) =>
      build({
        kind: 'cli',
        tool: 'codex',
        contextLength: 8192,
        temperature: 0.3,
        ...(ch !== undefined && { authChannel: ch }),
      }),
  },
  {
    name: 'Claude stream',
    tool: 'claude-code',
    run: (ch) => callPlanner(claudePlanner(ch), { projectDir, callbacks: callbacks() }),
  },
  {
    name: 'Claude one-shot',
    tool: 'claude-code',
    run: (ch) => claudePlanner(ch).review('prompt', projectDir, callbacks()),
  },
];

async function settle(run: () => Promise<unknown>): Promise<unknown> {
  try {
    return await run();
  } catch (cause) {
    return cause;
  }
}

function expectHostConfiguredIdentity(tool: string, configuredChannel?: CliAuthChannelId): void {
  expect(dispatch.recorders.length).toBeGreaterThan(0);
  for (const { context, events } of dispatch.recorders) {
    const identity = context.invocationIdentity;
    expect(identity).toEqual({
      version: 1,
      capturedAt: expect.any(Number),
      runner: { kind: 'cli', id: tool },
      ...(configuredChannel !== undefined && { configuredChannel }),
      billing: { posture: 'unknown', basis: 'unknown' },
    });
    expect(events[0]).toMatchObject({ type: 'call_started', invocationIdentity: identity });
    expect(events.length).toBeGreaterThan(1);
    for (const event of events) expect(event.invocationIdentity).toEqual(identity);
  }
}

describe('CLI invocation identity at dispatch', () => {
  describe.each(ROUTES)('$name', ({ tool, run }) => {
    it.each<Outcome>(['completed', 'failed', 'aborted'])(
      'fixes a host-configured identity before call_started and keeps it through a %s attempt',
      async (outcome) => {
        dispatch.outcome = outcome;

        await settle(() => run(undefined));

        expect(dispatch.spawns).toBe(1);
        expectHostConfiguredIdentity(tool);
        const terminal = dispatch.recorders.at(-1)?.events.at(-1);
        expect(terminal?.type).toBe(outcome === 'completed' ? 'call_completed' : 'call_error');
      },
    );

    it.each(['session', 'api-key'] as const)(
      'refuses an explicit unproven %s channel before dispatch and records no call',
      async (authChannel) => {
        const settled = await settle(() => run(authChannel));

        // The build pipeline reports the thrown refusal as a failed result; the others rethrow it.
        if (settled instanceof Error) {
          expect(settled).toMatchObject({ kind: 'runner-auth-channel-unenforced' });
        }
        expect(
          settled instanceof Error ? settled.message : (settled as { error?: string }).error,
        ).toContain('Remove authChannel from this runner');
        expect(dispatch.spawns).toBe(0);
        expect(dispatch.recorders).toEqual([]);
      },
    );
  });

  it('runs a provider-dependent route on the host configuration with unknown billing', async () => {
    await settle(() =>
      build({
        kind: 'cli',
        tool: 'opencode',
        authChannel: 'provider-dependent',
        model: 'anthropic/claude-sonnet-4-5',
        contextLength: 8192,
        temperature: 0.3,
      }),
    );

    expect(dispatch.spawns).toBe(1);
    expectHostConfiguredIdentity('opencode', 'provider-dependent');
  });
});
