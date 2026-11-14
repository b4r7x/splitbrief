import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import type { ReadinessReport } from '../../../core/readiness/types.js';
import { CLI_TOOL_CATALOG } from '../../../core/runners/cli-tool/catalog.js';
import { detectRunnerEvidence } from '../../detection/runner-evidence/detect.js';
import type { CliProbeContract } from '../cli-tools/probe/contract.js';
import { resolveCustomExecutable } from '../cli-executable/custom.js';
import { collectRunnerAdmissionChecks, prepareExecution } from './prepare.js';
import type { PrepareExecutionDependencies } from './types.js';
import {
  activateCompatibleCliShim,
  installCompatibleCliShim,
} from '#testing/helpers/compatible-cli-shim.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { createImplementerSeat } from '../../orchestrator/run/init/seats.js';
import { createEventBus } from '../../events/bus.js';
import { createCustomRunnerRuntime } from '../custom/runtime.js';

const tempDirs: string[] = [];

// A signed-in Codex host, so every seat is refused on its version and never waits on a sign-in retry.
beforeEach(() => {
  const home = tempDir('prepare-execution-home');
  mkdirSync(join(home, '.codex'));
  writeFileSync(join(home, '.codex', 'auth.json'), '{"tokens":{}}\n');
  vi.stubEnv('HOME', home);
  vi.stubEnv('XDG_CONFIG_HOME', join(home, '.config'));
  vi.stubEnv('CODEX_HOME', join(home, '.codex'));
  vi.stubEnv('OPENAI_API_KEY', '');
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  for (const directory of tempDirs.splice(0)) cleanupTempDir(directory);
});

function tempDir(prefix: string): string {
  const directory = createTempDir(prefix);
  tempDirs.push(directory);
  return directory;
}

/** The real node binary with the digest-bound identity the start gate trusts. */
async function nodeExecutable(projectDir: string) {
  const resolved = await resolveCustomExecutable({
    command: 'node',
    projectDir,
    pathEnv: process.env.PATH,
    pathExt: '',
  });
  if (resolved.kind !== 'resolved') throw new Error('Node executable did not resolve');
  return resolved.executable;
}

/**
 * A Codex stand-in whose `--version` never answers: each spawn appends a line to `spawnLog` and
 * creates `started`, then holds. Its status command reports a sign-in at once.
 */
function hungVersionProbe(spawnLog: string, started: string): CliProbeContract {
  const command = (script: string) =>
    ({
      command: ['node', '-e', script] as const,
      cwd: 'neutral' as const,
      maxOutputBytes: 1_024,
    }) as const;
  const testedVersion = CLI_TOOL_CATALOG.codex.compatibility.testedVersion;
  const version = command(
    [
      "const fs = require('node:fs');",
      `fs.appendFileSync(${JSON.stringify(spawnLog)}, 'version\\n');`,
      `fs.writeFileSync(${JSON.stringify(started)}, '');`,
      'setInterval(() => {}, 1_000_000);',
    ].join(' '),
  );
  const auth = command("console.log('verified')");
  return {
    version,
    declared: {
      kind: 'declared',
      version: {
        ...version,
        kind: 'version',
        parse: () => ({ kind: 'success', value: testedVersion }),
      },
      auth: { ...auth, kind: 'auth-status', parse: () => 'verified' },
      catalog: { kind: 'not-run' },
    },
  };
}

function readyReport(projectDir: string): ReadinessReport {
  return {
    generatedAt: '2026-11-03T00:00:00.000Z',
    projectDir,
    status: 'ready',
    counts: { ok: 1, info: 0, warning: 0, blocker: 0 },
    nextAction: { kind: 'continue', label: 'Continue', reason: 'Ready' },
    sections: [
      {
        id: 'runners',
        title: 'Runners',
        checks: [{ id: 'runners.configured', severity: 'ok', summary: 'Configured' }],
      },
    ],
    metadata: {},
  };
}

/**
 * Fires each probe deadline once the hung child has said it started, until the preparation ends.
 * The clock moves only on those deadlines, so the elapsed fake time is the time the start waited.
 */
async function expireVersionDeadlines<T>(pending: Promise<T>, started: string): Promise<T> {
  let settled = false;
  pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  while (!settled) {
    await new Promise<void>((resolve) => {
      const poll = setInterval(() => {
        if (!settled && !existsSync(started)) return;
        clearInterval(poll);
        resolve();
      }, 5);
    });
    if (settled) break;
    rmSync(started);
    await vi.advanceTimersToNextTimerAsync();
  }
  return pending;
}

describe('three seats on one CLI whose --version hangs', () => {
  const seat = { kind: 'cli', tool: 'codex', model: 'gpt-6-mini' } as const;

  it.each(['start', 'doctor'] as const)(
    'the %s check waits one probe deadline and spawns the version check once',
    async (entry) => {
      const projectDir = tempDir('prepare-execution-project');
      const probeDir = tempDir('prepare-execution-probe');
      const spawnLog = join(probeDir, 'version-spawns');
      const started = join(probeDir, 'version-started');
      const executable = await nodeExecutable(projectDir);
      const config = makeConfig({ planner: seat, implementer: seat, reviewer: seat });
      const deps: Partial<PrepareExecutionDependencies> = {
        detectRunnerEvidence: (options) =>
          detectRunnerEvidence({
            ...options,
            resolveExecutable: async () => executable,
            lookupProbe: () => hungVersionProbe(spawnLog, started),
          }),
        collectReadiness: async () => ({ report: readyReport(projectDir), config }),
      };
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      const armedAt = Date.now();

      const checks =
        entry === 'start'
          ? await expireVersionDeadlines(
              prepareExecution({
                feature: 'hung version',
                projectDir,
                effectiveConfig: config,
                configWarnings: [],
                signal: new AbortController().signal,
                policy: {
                  purpose: 'new-workflow',
                  interaction: 'headless',
                  unverifiedAuth: 'denied',
                  allowRepoRunners: false,
                  allowHooks: true,
                },
                deps,
              }),
              started,
            ).then((outcome) =>
              'report' in outcome && outcome.report
                ? outcome.report.sections.flatMap((section) => section.checks)
                : [],
            )
          : await expireVersionDeadlines(
              collectRunnerAdmissionChecks({
                projectDir,
                config,
                interaction: 'headless',
                routeCatalogs: new Map(),
                deps,
              }),
              started,
            );

      expect(readFileSync(spawnLog, 'utf8').split('\n').filter(Boolean)).toHaveLength(1);
      expect(Date.now() - armedAt).toBe(60_000);
      expect(checks).toContainEqual(
        expect.objectContaining({
          summary: 'PLAN, BUILD and REVIEW cannot start with OpenAI Codex CLI.',
        }),
      );
    },
    30_000,
  );
});

describe('a CLI tool written over in place during a run', () => {
  const seat = { kind: 'cli', tool: 'codex', model: 'gpt-6-mini' } as const;

  function codexRelease(directory: string, version: string) {
    return installCompatibleCliShim({
      directory,
      tool: 'codex',
      version,
      invocation: {
        stdoutLines: [
          JSON.stringify({
            type: 'item.completed',
            item: { type: 'agent_message', text: `built by ${version}` },
          }),
          JSON.stringify({ type: 'turn.completed' }),
        ],
      },
    });
  }

  /** Prepares a run whose every seat is the Codex release on PATH, and builds its BUILD seat. */
  async function preparedBuildSeat(projectDir: string) {
    const config = makeConfig({ planner: seat, implementer: seat, reviewer: seat });
    const outcome = await prepareExecution({
      feature: 'rewrite in place',
      projectDir,
      effectiveConfig: config,
      configWarnings: [],
      signal: new AbortController().signal,
      policy: {
        purpose: 'new-workflow',
        interaction: 'headless',
        unverifiedAuth: 'denied',
        allowRepoRunners: false,
        allowHooks: true,
      },
      deps: { collectReadiness: async () => ({ report: readyReport(projectDir), config }) },
    });
    if (outcome.kind !== 'prepared') {
      throw new Error(`Preparation did not admit the seats: ${JSON.stringify(outcome)}`);
    }
    const { implementer } = await createImplementerSeat({
      config: outcome.execution.config,
      prepared: outcome.execution,
      customRuntime: createCustomRunnerRuntime({
        projectDir,
        sessionId: 'rewrite-in-place',
        sweepStaleReviews: false,
        admission: { interaction: 'headless', allowRepoRunners: false },
        onArtifactApproval: async () => ({ approved: true as const }),
      }),
      signal: undefined,
      bus: createEventBus(),
      injectedImplementer: undefined,
    });
    return {
      build: () =>
        implementer.implement({
          task: makeTask(),
          projectDir,
          config: outcome.execution.config,
          context: { name: 'rewrite-in-place', dir: projectDir },
          onOutput: () => {},
          allowNoChange: true,
        }),
    };
  }

  it('BUILD checks a newer release written over the admitted file and finishes the call on it', async () => {
    const projectDir = tempDir('rewrite-in-place-project');
    createTestGitRepo(projectDir);
    const binDir = tempDir('rewrite-in-place-bin');
    const restoreShim = activateCompatibleCliShim(codexRelease(binDir, '0.40.0'));
    try {
      const { build } = await preparedBuildSeat(projectDir);
      expect(await build()).toMatchObject({ success: true, output: 'built by 0.40.0' });

      codexRelease(binDir, '0.41.0');
      const result = await build();

      expect(result.error).toBeUndefined();
      expect(result).toMatchObject({ success: true, output: 'built by 0.41.0' });
    } finally {
      restoreShim();
    }
  });

  it('BUILD stops on a check failure when the release written over the admitted file is too old', async () => {
    const projectDir = tempDir('rewrite-too-old-project');
    createTestGitRepo(projectDir);
    const binDir = tempDir('rewrite-too-old-bin');
    const restoreShim = activateCompatibleCliShim(codexRelease(binDir, '0.40.0'));
    try {
      const { build } = await preparedBuildSeat(projectDir);

      codexRelease(binDir, '0.0.1');
      const result = await build();

      expect(result).toMatchObject({
        success: false,
        outcome: 'runner-check-failed',
        error: expect.stringContaining('OpenAI Codex CLI version is not compatible.'),
      });
    } finally {
      restoreShim();
    }
  });
});
