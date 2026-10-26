import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplStateWithMetadata as implementingState } from '#testing/helpers/factories/workflow-state.js';
import { makeBusRecorder, makePlanner } from '#testing/helpers/orchestrator-factories.js';
import { consultCallAnswering, guidanceConsult } from '#testing/helpers/typed-planner.js';
import {
  cleanupTaskProjects,
  makeTaskWorkflowContext as makeWorkflowContext,
  setupTaskProject as setupProject,
} from '#testing/helpers/orchestrator-task-context.js';
import { cliDetectionsFor, rememberDetectedTools } from '#testing/helpers/factories/detection.js';
import { prependPath, trustedShimGate } from '#testing/helpers/command-shim.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { writeConfig } from '../../../core/config/load/io.js';
import { CLI_TOOL_CATALOG, type CliToolId } from '../../../core/runners/cli-tool-catalog.js';
import type { CliImplementerConfig } from '../../../core/schemas/implementer-config.js';
import type { RunnerCallContext } from '../../calls/types.js';
import { createCliImplementer } from '../../implementers/cli.js';
import { antigravityImplementerAdapter } from '../../runners/cli-tools/antigravity.js';
import { invokeProcessCli } from '../../runners/cli-tools/process-invoke.js';
import { runTaskLoop } from './loop.js';

const QUOTA_LINE =
  'error: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 2h6m30s.';

function cliSeat(
  tool: CliToolId,
  fallback?: CliImplementerConfig['fallback'],
): CliImplementerConfig {
  return {
    kind: 'cli',
    tool,
    ...(CLI_TOOL_CATALOG[tool].auth.kind === 'provider-dependent' && {
      authChannel: 'provider-dependent',
    }),
    contextLength: 2_000_000,
    ...(fallback !== undefined && { fallback }),
  } as CliImplementerConfig;
}

function executableIdentity(candidate: string) {
  const path = realpathSync(candidate);
  const info = statSync(path);
  return {
    path,
    fingerprint: {
      dev: info.dev,
      ino: info.ino,
      size: info.size,
      mtimeMs: info.mtimeMs,
    },
  };
}

afterEach(cleanupTaskProjects);

describe('a quota line that arrives during a live call', { timeout: 30_000 }, () => {
  const shimDirs: string[] = [];
  let restorePath: (() => void) | undefined;
  afterEach(() => {
    restorePath?.();
    restorePath = undefined;
    while (shimDirs.length > 0) cleanupTempDir(shimDirs.pop() as string);
  });

  it('fails an invokeProcessCli call on stderr quota within five seconds when agy stays alive', async () => {
    const shimDir = createTempDir('agy-live-quota-shim');
    shimDirs.push(shimDir);
    const shimPath = join(shimDir, CLI_TOOL_CATALOG.antigravity.command);
    writeFileSync(
      shimPath,
      [
        '#!/bin/bash',
        'cat >/dev/null',
        `printf '%s\\n' ${JSON.stringify(QUOTA_LINE)} >&2`,
        'sleep 30',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
    restorePath = prependPath(shimDir);
    const callContext: RunnerCallContext = {
      callId: 'stderr-quota-test',
      role: 'implementer',
      backendKind: 'cli',
      runnerName: 'fixture',
    };
    const started = Date.now();
    const result = await invokeProcessCli(antigravityImplementerAdapter, {
      invocation: {
        executable: executableIdentity(shimPath),
        args: [],
        promptTransport: antigravityImplementerAdapter.promptTransport,
        environment: { PATH: process.env.PATH ?? '' },
        cwd: shimDir,
        timeoutMs: 15_000,
        signal: undefined,
      },
      prompt: 'fixture prompt',
      callContext,
    });
    const elapsed = Date.now() - started;
    expect(result).toMatchObject({
      status: 'failed',
      error: {
        code: 'usage-limit',
        message: QUOTA_LINE,
      },
    });
    expect(elapsed).toBeLessThan(5_000);
  });

  it('halts antigravity on stderr quota at once and takes the declared fallback', async () => {
    const shimDir = createTempDir('antigravity-quota-shim');
    shimDirs.push(shimDir);
    const counter = join(shimDir, 'spawned');
    writeFileSync(
      join(shimDir, CLI_TOOL_CATALOG.antigravity.command),
      [
        '#!/bin/bash',
        'cat >/dev/null',
        `echo x >> ${counter}`,
        `printf '%s\\n' ${JSON.stringify(QUOTA_LINE)} >&2`,
        'sleep 30',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
    restorePath = prependPath(shimDir);
    const seat = cliSeat('antigravity', { tool: 'claude-code' });
    const config = makeConfig({
      implementer: seat,
      validation: { endChecks: false, testCommand: 'noop' },
    });
    const { projectDir, sessionId } = setupProject();
    writeConfig(projectDir, config);
    await rememberDetectedTools(
      projectDir,
      cliDetectionsFor('ready', ['antigravity', 'claude-code']),
    );
    const { bus, events } = makeBusRecorder();
    const consult = vi.fn(() => guidanceConsult());
    const wctx = makeWorkflowContext({
      projectDir,
      sessionId,
      implementer: createCliImplementer(seat, {
        trustedCli: trustedShimGate({ dir: shimDir, tool: 'antigravity' }),
      }),
      planner: makePlanner({ typedCall: consultCallAnswering(consult) }),
      bus,
      config,
    });

    const started = Date.now();
    const { state } = await runTaskLoop({
      wctx,
      initialState: implementingState([makeTask({ id: 'T001' })]),
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });
    const elapsed = Date.now() - started;

    const issue = state.pendingRecovery;
    expect({
      spawned: existsSync(counter) ? readFileSync(counter, 'utf8') : '',
      retries: events.filter((event) => event.type === 'task_retry').length,
      consults: consult.mock.calls.length,
      reason: issue?.reason,
      auto: issue?.switchSeat?.auto?.candidate,
    }).toEqual({
      spawned: 'x\n',
      retries: 0,
      consults: 0,
      reason: 'runner-usage-limit',
      auto: { tool: 'claude-code' },
    });
    expect(elapsed).toBeLessThan(10_000);
  });
});
