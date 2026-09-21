import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useTrustHome } from '#testing/helpers/trust-home.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import {
  makeCallbacks,
  makePlanner,
  makeImplementer,
} from '#testing/helpers/orchestrator-factories.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeRunnerGate } from '#testing/helpers/runner-gate.js';
import { initializeWorkflow } from './init.js';
import { createRunIsolation } from '../isolation/create.js';
import type { RunIsolation } from '../isolation/types.js';
import { markHooksConfigTrusted } from '../../../core/hooks/trust.js';
import { ensureHooksTrusted } from '../../../cli/hook-trust-prompt.js';
import { rejectUntrustedRunners } from '../../runners/trust.js';
import type { HooksConfig } from '../../../core/schemas/hooks.js';
import type { Config } from '../../../core/schemas/config.js';
import { resolveImplementerProfiles } from '../../../core/config/accessors/implementer-profiles.js';
import { ensureSessionDir } from '../../../core/paths-io.js';
import { reactivateExistingSession } from '../../../core/sessions/active-pointer.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { SummaryBase } from '../summary/build.js';
import type { SpecMetadata } from '../../../core/paths-io.js';
import { parsePreparedConfig } from '../../runners/prepared-execution.js';

function makeCopyingIsolation(projectDir: string, sessionId: string): RunIsolation {
  return createRunIsolation({
    projectDir,
    sessionId,
    strategy: 'staged-copy',
    onFallback: () => {},
    onRetained: () => {},
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
});

afterEach(() => {
  while (dirs.length) cleanupTempDir(dirs.pop() as string);
  trustHome.restore();
});

function setupProjectDir(prefix: string) {
  const projectDir = createTempDir(prefix);
  dirs.push(projectDir);
  mkdirSync(join(projectDir, '.splitbrief'), { recursive: true });
  mkdirSync(join(projectDir, '.git'), { recursive: true });
  writeFileSync(join(projectDir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  return projectDir;
}

type InitCallerOptions = Readonly<{
  allowHooks?: boolean;
  allowRepoRunners?: boolean;
  config?: Config;
}>;

function makeInitArgs(projectDir: string, hooks?: HooksConfig, extra: InitCallerOptions = {}) {
  const feature = 'test-feature';
  const sessionId = 'test-session';
  const config =
    extra.config ??
    makeConfig({
      validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
      workflow: { mode: 'quick' },
      ...(hooks !== undefined && { hooks }),
    });
  const { callbacks } = makeCallbacks();
  const summaryBase: SummaryBase = {
    feature,
    startTime: Date.now(),
    plannerTool: 'test',
    implementerTool: 'test',
    mode: 'quick',
    projectDir,
    sessionId,
  };
  const metadata: SpecMetadata = { plannerTool: 'test', implementerTool: 'test', mode: 'quick' };
  return {
    projectDir,
    feature,
    config,
    allowHooks: extra.allowHooks ?? false,
    allowRepoRunners: extra.allowRepoRunners ?? false,
    callbacks,
    sessionId,
    summaryBase,
    metadata,
    setTracked: (_s: WorkflowState) => {},
  };
}

async function initializeFromCaller(args: ReturnType<typeof makeInitArgs>) {
  const hooks = args.config.hooks;
  await ensureHooksTrusted(
    {
      projectDir: args.projectDir,
      hooks,
      allowHooks: args.allowHooks,
    },
    async () => '',
  );
  const config = parsePreparedConfig(hooks === undefined ? args.config : { ...args.config, hooks });
  rejectUntrustedRunners({
    config,
    projectDir: args.projectDir,
    allowRepoRunners: args.allowRepoRunners,
  });
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
  return initializeWorkflow({
    opts: {
      prepared: {
        purpose: 'new-workflow',
        config,
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
        session: {
          kind: 'existing',
          ref: { projectDir: args.projectDir, sessionId: args.sessionId },
          active,
        },
        runtime: {
          feature: args.feature,
          allowHooks: args.allowHooks,
          allowRepoRunners: args.allowRepoRunners,
        },
      },
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

  it('does not let allowHooks authorize repo-local runner commands', async () => {
    const projectDir = setupProjectDir('hook-trust-runner-block');
    const config = makeConfig({
      implementer: {
        kind: 'agent',
        command: './scripts/agent',
        model: 'agent-default',
      },
      validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
      workflow: { mode: 'quick' },
      hooks: HOOK,
    });
    const args = makeInitArgs(projectDir, HOOK, { allowHooks: true, config });

    await expect(initializeFromCaller(args)).rejects.toMatchObject({
      kind: 'runner-not-trusted',
    });
  });

  it('allows repo-local runner commands when allowRepoRunners is true', async () => {
    const projectDir = setupProjectDir('hook-trust-runner-allow');
    const config = makeConfig({
      implementer: {
        kind: 'agent',
        command: './scripts/agent',
        model: 'agent-default',
      },
      validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
      workflow: { mode: 'quick' },
      hooks: HOOK,
    });
    const args = makeInitArgs(projectDir, HOOK, {
      allowHooks: true,
      allowRepoRunners: true,
      config,
    });

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
