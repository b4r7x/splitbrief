import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { platform } from 'node:process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { expireDeadlineAfterFile, freezeProbeDeadlines } from '#testing/helpers/fake-timers.js';
import { stubSignInHome } from '#testing/helpers/sign-in-home.js';
import { withTempDir } from '#testing/helpers/temp-dir.js';
import {
  CODEX_VERSION_LINES,
  installToolShim,
  signInCodexShim,
} from '#testing/helpers/tool-shim.js';
import type { RunnerDiscoveryContext } from '../../../core/config/accessors/runner-discovery-context.js';
import { admitStart } from '../../../core/discovery/runner-evidence.js';
import { CLI_TOOL_CATALOG } from '../../../core/runners/cli-tool/catalog.js';
import type { CliAuthChannelId } from '../../../core/runners/cli-tool/auth-channels.js';
import type { CliExecutableResolver } from '../../runners/cli-executable/types.js';
import { detectRunnerEvidence } from './detect.js';

const TESTED_VERSION = CLI_TOOL_CATALOG.codex.compatibility.testedVersion;

/** One clock for every call: an injected seam is part of the observation's identity. */
const observationClock = () => 1_000;

freezeProbeDeadlines();

afterEach(() => {
  vi.unstubAllEnvs();
});

function cliContext(
  input: Readonly<{
    authChannel?: CliAuthChannelId | undefined;
    model?: string | undefined;
    role?: 'planner' | 'implementer' | undefined;
    configGeneration?: string | undefined;
  }> = {},
): RunnerDiscoveryContext {
  return {
    role: input.role ?? 'planner',
    kind: 'cli',
    id: 'codex',
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.authChannel === undefined ? {} : { authChannel: input.authChannel }),
    credentialPresent: false,
    configGeneration: input.configGeneration ?? 'observation-generation',
  };
}

function detect(
  input: Readonly<{
    context: RunnerDiscoveryContext;
    resolveExecutable: CliExecutableResolver;
    signal?: AbortSignal | undefined;
  }>,
) {
  return detectRunnerEvidence({
    context: input.context,
    projectDir: '/observation/project',
    resolveExecutable: input.resolveExecutable,
    now: observationClock,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
}

/** Polls on a real interval: the probe deadlines run on a held clock. */
function waitUntil(done: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const poll = setInterval(() => {
      if (!done()) return;
      clearInterval(poll);
      resolve();
    }, 5);
  });
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * A signed-in `codex` whose version check holds until the test releases it, so the calls of a test
 * are in flight together. Each version check writes its process id.
 */
async function gatedCodex(directory: string) {
  const argvLog = join(directory, 'argv.log');
  const pids = join(directory, 'version-pids');
  const released = join(directory, 'released');
  const executable = await installToolShim(
    directory,
    'codex',
    signInCodexShim({
      argvLog,
      versionLines: [
        `printf '%s\\n' "$$" >> ${JSON.stringify(pids)}`,
        `while [ ! -f ${JSON.stringify(released)} ]; do sleep 0.01; done`,
        ...CODEX_VERSION_LINES,
      ],
    }),
  );
  await stubSignInHome(join(directory, 'home'), ['codex']);
  const lines = (path: string): string[] =>
    existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean) : [];
  return {
    resolveExecutable: async () => executable,
    calls: () => lines(argvLog).filter((line) => line === '--version').length,
    statusChecks: () => lines(argvLog).filter((line) => line === 'login status').length,
    versionPids: () => lines(pids).map(Number),
    started: (count: number) => waitUntil(() => lines(pids).length === count),
    release: () => writeFileSync(released, ''),
  };
}

describe('detectRunnerEvidence in-flight sharing', () => {
  it.runIf(platform !== 'win32').each(['session', 'provider-dependent', undefined] as const)(
    'does not reuse native auth observations for %s without account freshness',
    async (authChannel) => {
      await withTempDir('evidence-no-reuse', async (directory) => {
        const fixture = await gatedCodex(directory);
        try {
          const options = {
            context: cliContext({ authChannel }),
            resolveExecutable: fixture.resolveExecutable,
          };
          const first = detect(options);
          const second = detect(options);
          await fixture.started(2);
          fixture.release();
          await expect(first).resolves.toMatchObject({ auth: 'verified' });
          await expect(second).resolves.toMatchObject({ auth: 'verified' });
          expect(fixture.calls()).toBe(2);
        } finally {
          fixture.release();
        }
      });
    },
  );

  it.runIf(platform !== 'win32')(
    'probes afresh after the previous observation has settled',
    async () => {
      await withTempDir('evidence-afresh', async (directory) => {
        const fixture = await gatedCodex(directory);
        fixture.release();
        const options = {
          context: cliContext({ authChannel: 'session' }),
          resolveExecutable: fixture.resolveExecutable,
        };

        await detect(options);
        await detect(options);

        expect(fixture.calls()).toBe(2);
      });
    },
  );

  it.runIf(platform !== 'win32')(
    'cancels one native observation without cancelling another',
    async () => {
      await withTempDir('evidence-cancel-one', async (directory) => {
        const fixture = await gatedCodex(directory);
        try {
          const options = {
            context: cliContext({ authChannel: 'session' }),
            resolveExecutable: fixture.resolveExecutable,
          };
          const leaving = new AbortController();

          const cancelled = detect({ ...options, signal: leaving.signal });
          await fixture.started(1);
          const staying = detect({ ...options, signal: new AbortController().signal });
          await fixture.started(2);
          const [cancelledPid, stayingPid] = fixture.versionPids();
          leaving.abort();

          await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
          await waitUntil(() => cancelledPid !== undefined && !isRunning(cancelledPid));
          expect(stayingPid !== undefined && isRunning(stayingPid)).toBe(true);
          fixture.release();
          await expect(staying).resolves.toMatchObject({ auth: 'verified' });
          expect(fixture.calls()).toBe(2);
          expect(fixture.statusChecks()).toBe(1);
        } finally {
          fixture.release();
        }
      });
    },
  );

  it.runIf(platform !== 'win32')(
    'aborts each native observation when its caller leaves',
    async () => {
      await withTempDir('evidence-abort-each', async (directory) => {
        const fixture = await gatedCodex(directory);
        try {
          const options = {
            context: cliContext({ authChannel: 'session' }),
            resolveExecutable: fixture.resolveExecutable,
          };
          const first = new AbortController();
          const second = new AbortController();

          const one = detect({ ...options, signal: first.signal });
          await fixture.started(1);
          const two = detect({ ...options, signal: second.signal });
          await fixture.started(2);
          const [firstPid, secondPid] = fixture.versionPids();
          first.abort();
          await expect(one).rejects.toMatchObject({ name: 'AbortError' });
          await waitUntil(() => firstPid !== undefined && !isRunning(firstPid));
          expect(secondPid !== undefined && isRunning(secondPid)).toBe(true);
          second.abort();
          await expect(two).rejects.toMatchObject({ name: 'AbortError' });
          await waitUntil(() => secondPid !== undefined && !isRunning(secondPid));

          expect(fixture.calls()).toBe(2);
          expect(fixture.statusChecks()).toBe(0);
        } finally {
          fixture.release();
        }
      });
    },
  );
});

/** The evidence of a signed-in `codex` whose version check never answers before its deadline. */
function timedOutVersionEvidence() {
  return withTempDir('evidence-version-timeout', async (directory) => {
    const started = join(directory, 'version-started');
    const executable = await installToolShim(
      directory,
      'codex',
      signInCodexShim({
        argvLog: join(directory, 'argv.log'),
        versionLines: [`: > ${JSON.stringify(started)}`, 'exec tail -f /dev/null'],
      }),
    );
    await stubSignInHome(join(directory, 'home'), ['codex']);
    const pending = detect({
      context: cliContext({ authChannel: 'session' }),
      resolveExecutable: async () => executable,
    });
    await expireDeadlineAfterFile(started);
    return pending;
  });
}

describe('a start after a version check that timed out', () => {
  it.runIf(platform !== 'win32')('keeps the timeout as the compatibility fact', async () => {
    const evidence = await timedOutVersionEvidence();

    expect(evidence.auth).toBe('verified');
    expect(evidence.compatibility).toEqual({
      kind: 'timeout',
      installedVersion: null,
      testedVersion: TESTED_VERSION,
    });
  });

  it.runIf(platform !== 'win32').each(['interactive', 'headless'] as const)(
    'is refused for a %s start, as an unread version is',
    async (interaction) => {
      const evidence = await timedOutVersionEvidence();

      expect(
        admitStart({
          evidence,
          expectedContextKey: evidence.context.key,
          expectedSelectionId: evidence.modelRun.selectionId,
          requiredFacts: ['compatible-version', 'authentication'],
          interaction,
          unverifiedAuth: 'allowed',
          route: { kind: 'unchecked' },
        }),
      ).toMatchObject({ kind: 'denied', reason: { kind: 'compatibility', fact: 'timeout' } });
    },
  );
});

/** A signed-in `codex` that writes over its own file during the `check` command. */
function driftingCodex(check: 'version' | 'auth'): string {
  const drift = `  printf '%s\\n' '#' >> "$0"`;
  return [
    '#!/bin/sh',
    'if [ "$1" = "--version" ]; then',
    ...(check === 'version' ? [drift] : []),
    `  printf '%s\\n' 'codex-cli ${TESTED_VERSION}'`,
    '  exit 0',
    'fi',
    'if [ "$1" = "login" ] && [ "$2" = "status" ]; then',
    ...(check === 'auth' ? [drift] : []),
    "  printf '%s\\n' 'Logged in'",
    '  exit 0',
    'fi',
    'exit 1',
    '',
  ].join('\n');
}

describe('a declared probe that a cancellation cut short', () => {
  it.runIf(platform !== 'win32').each([{ check: 'version' }, { check: 'auth' }] as const)(
    'reports a drifted executable and no read version when the $check check was cancelled',
    async ({ check }) => {
      await withTempDir('evidence-drifted', async (directory) => {
        const executable = await installToolShim(directory, 'codex', driftingCodex(check));
        await stubSignInHome(join(directory, 'home'), ['codex']);

        const evidence = await detect({
          context: cliContext({ authChannel: 'session' }),
          resolveExecutable: async () => executable,
        });

        expect(evidence).toEqual({
          runner: { id: 'codex', kind: 'cli', locality: 'unknown', enabled: 'enabled' },
          context: { key: evidence.context.key, observedAt: 1_000, source: 'fresh' },
          endpoint: { kind: 'not-run' },
          catalog: { kind: 'not-run' },
          modelRun: {
            kind: 'unknown',
            selectionId: 'unselected',
            observedAt: 1_000,
            contextKey: evidence.context.key,
          },
          installation: 'installed',
          executable: { kind: 'identity-drifted' },
          compatibility: { kind: 'unknown', installedVersion: null, testedVersion: TESTED_VERSION },
          credential: 'unknown',
          auth: 'cancelled',
        });
      });
    },
  );
});
