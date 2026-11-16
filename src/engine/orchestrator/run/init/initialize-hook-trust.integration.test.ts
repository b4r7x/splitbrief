import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useTrustHome } from '#testing/helpers/trust-home.js';
import { realpathSync } from 'node:fs';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import {
  makeCallbacks,
  makePlanner,
  makeImplementer,
} from '#testing/helpers/orchestrator-factories.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeRunnerGate, testCliSeats } from '#testing/helpers/runner-gate.js';
import { initializeWorkflow } from './initialize.js';
import { createRunIsolation } from '../../isolation/create.js';
import type { RunIsolation } from '../../isolation/types.js';
import { markHooksConfigTrusted } from '../../../../core/hooks/trust.js';
import { writeConfig } from '../../../../core/config/load/io.js';
import { runHeadlessStart } from '../../../../cli/commands/start/streaming.js';
import type { HooksConfig } from '../../../../core/schemas/hooks.js';
import { resolveImplementerProfiles } from '../../../../core/config/accessors/implementer-profiles.js';
import { ensureSessionDir } from '../../../../core/sessions/spec-files.js';
import { reactivateExistingSession } from '../../../../core/sessions/active-pointer.js';
import type { WorkflowState } from '../../../../core/schemas/workflow/state.js';
import type { SummaryBase } from '../../summary/build.js';
import type { SpecMetadata } from '../../../../core/sessions/spec-files.js';
import {
  parsePreparedConfig,
  type PreparedExecution,
} from '../../../runners/prepare-execution/prepared.js';

function makeCopyingIsolation(projectDir: string, sessionId: string): RunIsolation {
  return createRunIsolation({
    projectDir,
    sessionId,
    strategy: 'staged-copy',
    onFallback: () => {},
  });
}

const HOOK: HooksConfig = {
  post_task: [
    {
      kind: 'command',
      command: 'echo',
      args: ['ok'],
      timeout_ms: 5000,
      on_failure: 'warn',
    },
  ],
};

const dirs: string[] = [];
let trustHome: ReturnType<typeof useTrustHome>;

beforeEach(() => {
  trustHome = useTrustHome('init-hook-trust-home');
  process.stdin.isTTY = false;
});

afterEach(() => {
  delete (process.stdin as { isTTY?: boolean }).isTTY;
  while (dirs.length) cleanupTempDir(dirs.pop() as string);
  trustHome.restore();
});

function setupProjectDir(prefix: string) {
  const projectDir = realpathSync(createTempDir(prefix));
  dirs.push(projectDir);
  createTestGitRepo(projectDir);
  return projectDir;
}

type InitCallerOptions = Readonly<{
  allowHooks?: boolean;
}>;

function makeInitArgs(projectDir: string, hooks?: HooksConfig, extra: InitCallerOptions = {}) {
  const feature = 'test-feature';
  const sessionId = 'test-session';
  const config = makeConfig({
    validation: { endChecks: false, testCommand: 'noop' },
    workflow: {},
    ...(hooks !== undefined && { hooks }),
  });
  const { callbacks } = makeCallbacks();
  const summaryBase: SummaryBase = {
    feature,
    startTime: Date.now(),
    plannerTool: 'test',
    implementerTool: 'test',
    projectDir,
    sessionId,
  };
  const metadata: SpecMetadata = {
    planner: 'test · auto',
    implementer: 'test · auto',
    reviewer: 'test · auto',
  };
  return {
    projectDir,
    feature,
    config,
    allowHooks: extra.allowHooks ?? false,
    callbacks,
    sessionId,
    summaryBase,
    metadata,
    setTracked: (_s: WorkflowState) => {},
  };
}

/**
 * Reaches `initializeWorkflow` through a headless `start`, so the hook trust gate under test is
 * the one the command runs: the config is read from disk, and only the runner preparation and the
 * run loop are stand-ins.
 */
async function initializeFromCaller(args: ReturnType<typeof makeInitArgs>) {
  writeConfig(args.projectDir, args.config);
  let init: Awaited<ReturnType<typeof initializeWorkflow>> | undefined;
  await runHeadlessStart({
    deps: {
      initStores: async () => {},
      renderApp: async () => {},
      prepareExecution: async (input) => ({
        kind: 'prepared',
        execution: preparedFromConfig(args, parsePreparedConfig(input.effectiveConfig)),
      }),
      runHeadless: async ({ prepared }) => {
        init = await initializeFromPrepared(args, prepared);
      },
    },
    projectDir: args.projectDir,
    feature: args.feature,
    enrichedFeature: undefined,
    plannerContext: undefined,
    opts: { allowHooks: args.allowHooks },
    mode: 'plain',
  });
  if (init === undefined) throw new Error('the headless start never reached the run');
  return init;
}

function preparedFromConfig(
  args: ReturnType<typeof makeInitArgs>,
  config: PreparedExecution['config'],
): PreparedExecution {
  const preparationId = `hook-trust-${args.sessionId}`;
  const gates = [
    makeRunnerGate(config.planner, { role: 'planner' }, preparationId),
    ...resolveImplementerProfiles(config).profiles.map((profile) =>
      makeRunnerGate(profile.config, { role: 'implementer', profile: profile.name }, preparationId),
    ),
  ];
  ensureSessionDir(args.projectDir, args.sessionId);
  const active = reactivateExistingSession({
    projectDir: args.projectDir,
    sessionId: args.sessionId,
  });
  return {
    purpose: 'new-workflow',
    config,
    sourceConfig: config,
    preparationId,
    report: {
      generatedAt: new Date(0).toISOString(),
      projectDir: args.projectDir,
      status: 'ready',
      counts: { ok: gates.length, info: 0, warning: 0, blocker: 0 },
      nextAction: { kind: 'continue', label: 'Continue', reason: 'ready' },
      sections: [],
      metadata: {},
    },
    gates,
    cliSeats: testCliSeats(gates),
    session: {
      kind: 'existing',
      ref: { projectDir: args.projectDir, sessionId: args.sessionId },
      active,
    },
    runtime: {
      feature: args.feature,
      allowHooks: args.allowHooks,
      allowRepoRunners: false,
    },
  };
}

function initializeFromPrepared(
  args: ReturnType<typeof makeInitArgs>,
  prepared: PreparedExecution,
) {
  const { config } = prepared;
  return initializeWorkflow({
    opts: {
      prepared,
      callbacks: args.callbacks,
      sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
      _planner: makePlanner(),
      _implementer: makeImplementer(),
    },
    config,
    sessionId: args.sessionId,
    summaryBase: args.summaryBase,
    metadata: args.metadata,
    setTrackedState: args.setTracked,
    resumeHolder: { messages: [] },
    isolation: makeCopyingIsolation(args.projectDir, args.sessionId),
  });
}

describe('engine-level hook trust gate', () => {
  it('blocks untrusted config hooks when allowHooks is not set', async () => {
    const projectDir = setupProjectDir('hook-trust-block');
    const args = makeInitArgs(projectDir, HOOK);

    await expect(initializeFromCaller(args)).rejects.toThrow(/not trusted/);
  });

  it('allows hooks when allowHooks is true', async () => {
    const projectDir = setupProjectDir('hook-trust-allow');
    const args = makeInitArgs(projectDir, HOOK, { allowHooks: true });

    const init = await initializeFromCaller(args);
    expect(init.ok).toBe(true);
  });

  it('allows pre-trusted hooks without allowHooks', async () => {
    const projectDir = setupProjectDir('hook-trust-pretrusted');
    markHooksConfigTrusted(projectDir, HOOK);
    const args = makeInitArgs(projectDir, HOOK);

    const init = await initializeFromCaller(args);
    expect(init.ok).toBe(true);
  });

  it('runs without hooks cleanly when no hooks are configured', async () => {
    const projectDir = setupProjectDir('hook-trust-no-hooks');
    const args = makeInitArgs(projectDir);

    const init = await initializeFromCaller(args);
    expect(init.ok).toBe(true);
  });
});
