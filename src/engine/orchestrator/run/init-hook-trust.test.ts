import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import {
  makeCallbacks,
  makePlanner,
  makeImplementer,
} from '#testing/helpers/orchestrator-factories.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { initializeWorkflow, type RunWorkflowOptions } from './init.js';
import { markHooksConfigTrusted, isHooksConfigTrusted } from '../../../core/hooks/trust.js';
import { resolveHooksConfig } from '../../hooks/discover.js';
import type { HooksConfig } from '../../../core/schemas/hooks.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { SummaryBase } from '../summary/build.js';
import type { SpecMetadata } from '../../../core/paths-io.js';

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

afterEach(() => {
  while (dirs.length) cleanupTempDir(dirs.pop() as string);
});

function setupProjectDir(prefix: string) {
  const projectDir = createTempDir(prefix);
  dirs.push(projectDir);
  mkdirSync(join(projectDir, '.splitbrief'), { recursive: true });
  mkdirSync(join(projectDir, '.git'), { recursive: true });
  writeFileSync(join(projectDir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  return projectDir;
}

function makeInitArgs(
  projectDir: string,
  hooks?: HooksConfig,
  extra?: Partial<RunWorkflowOptions>,
) {
  const feature = 'test-feature';
  const sessionId = 'test-session';
  const config = makeConfig({
    validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
    workflow: { mode: 'quick', persistTranscript: false, commitStrategy: 'none' },
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
  const opts: RunWorkflowOptions = {
    feature,
    projectDir,
    config,
    callbacks,
    sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
    _planner: makePlanner(),
    _implementer: makeImplementer(),
    ...extra,
  };

  return { opts, sessionId, summaryBase, metadata, setTracked: (_s: WorkflowState) => {} };
}

describe('engine-level hook trust gate', () => {
  it('blocks untrusted config hooks when allowHooks is not set', async () => {
    const projectDir = setupProjectDir('hook-trust-block');
    const args = makeInitArgs(projectDir, HOOK);

    await expect(
      initializeWorkflow({
        opts: args.opts,
        sessionId: args.sessionId,
        summaryBase: args.summaryBase,
        metadata: args.metadata,
        setTrackedState: args.setTracked,
        resumeHolder: { messages: [] },
      }),
    ).rejects.toThrow(/not trusted/);
  });

  it('allows hooks when allowHooks is true', async () => {
    const projectDir = setupProjectDir('hook-trust-allow');
    const args = makeInitArgs(projectDir, HOOK, { allowHooks: true });

    const init = await initializeWorkflow({
      opts: args.opts,
      sessionId: args.sessionId,
      summaryBase: args.summaryBase,
      metadata: args.metadata,
      setTrackedState: args.setTracked,
      resumeHolder: { messages: [] },
    });
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
      workflow: { mode: 'quick', persistTranscript: false, commitStrategy: 'none' },
      hooks: HOOK,
    });
    const args = makeInitArgs(projectDir, HOOK, { allowHooks: true, config });

    await expect(
      initializeWorkflow({
        opts: args.opts,
        sessionId: args.sessionId,
        summaryBase: args.summaryBase,
        metadata: args.metadata,
        setTrackedState: args.setTracked,
        resumeHolder: { messages: [] },
      }),
    ).rejects.toMatchObject({ kind: 'runner-not-trusted' });
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
      workflow: { mode: 'quick', persistTranscript: false, commitStrategy: 'none' },
      hooks: HOOK,
    });
    const args = makeInitArgs(projectDir, HOOK, {
      allowHooks: true,
      allowRepoRunners: true,
      config,
    });

    const init = await initializeWorkflow({
      opts: args.opts,
      sessionId: args.sessionId,
      summaryBase: args.summaryBase,
      metadata: args.metadata,
      setTrackedState: args.setTracked,
      resumeHolder: { messages: [] },
    });
    expect(init.ok).toBe(true);
  });

  it('allows pre-trusted hooks without allowHooks', async () => {
    const projectDir = setupProjectDir('hook-trust-pretrusted');
    markHooksConfigTrusted(projectDir, HOOK);
    const args = makeInitArgs(projectDir, HOOK);

    const init = await initializeWorkflow({
      opts: args.opts,
      sessionId: args.sessionId,
      summaryBase: args.summaryBase,
      metadata: args.metadata,
      setTrackedState: args.setTracked,
      resumeHolder: { messages: [] },
    });
    expect(init.ok).toBe(true);
  });

  it('blocks discovered filesystem hooks that are not trusted', async () => {
    const projectDir = setupProjectDir('hook-trust-discovered');
    const hooksDir = join(projectDir, '.splitbrief', 'hooks');
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(join(hooksDir, 'post-task.js'), 'export default function() {}');

    const args = makeInitArgs(projectDir);

    await expect(
      initializeWorkflow({
        opts: args.opts,
        sessionId: args.sessionId,
        summaryBase: args.summaryBase,
        metadata: args.metadata,
        setTrackedState: args.setTracked,
        resumeHolder: { messages: [] },
      }),
    ).rejects.toThrow(/not trusted/);
  });

  it('trust hash changes when discovered hook content changes', async () => {
    const projectDir = setupProjectDir('hook-trust-hash-change');
    const hooksDir = join(projectDir, '.splitbrief', 'hooks');
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(join(hooksDir, 'post-task.js'), 'export default function() { return "v1"; }');

    const mergedV1 = await resolveHooksConfig(projectDir, undefined);
    markHooksConfigTrusted(projectDir, mergedV1);
    expect(isHooksConfigTrusted(projectDir, mergedV1)).toBe(true);

    writeFileSync(join(hooksDir, 'post-task.js'), 'export default function() { return "v2"; }');

    const mergedV2 = await resolveHooksConfig(projectDir, undefined);
    expect(isHooksConfigTrusted(projectDir, mergedV2)).toBe(false);

    const args = makeInitArgs(projectDir);
    await expect(
      initializeWorkflow({
        opts: args.opts,
        sessionId: args.sessionId,
        summaryBase: args.summaryBase,
        metadata: args.metadata,
        setTrackedState: args.setTracked,
        resumeHolder: { messages: [] },
      }),
    ).rejects.toThrow(/not trusted/);
  });

  it('runs without hooks cleanly when no hooks configured or discovered', async () => {
    const projectDir = setupProjectDir('hook-trust-no-hooks');
    const args = makeInitArgs(projectDir);

    const init = await initializeWorkflow({
      opts: args.opts,
      sessionId: args.sessionId,
      summaryBase: args.summaryBase,
      metadata: args.metadata,
      setTrackedState: args.setTracked,
      resumeHolder: { messages: [] },
    });
    expect(init.ok).toBe(true);
  });
});
