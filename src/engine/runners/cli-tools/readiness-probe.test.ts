import { existsSync, readFileSync } from 'node:fs';
import { mkdir, realpath, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CliExecutableIdentity } from '../../../core/discovery/detection.js';
import { withTempDir } from '#testing/helpers/temp-dir.js';
import type { CliProbeContract } from './contract.js';
import { probeCliReadiness } from './readiness-probe.js';

async function nodeExecutable(): Promise<CliExecutableIdentity> {
  const path = await realpath(process.execPath);
  const info = await stat(path);
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

function probe(
  versionScript = "console.log('codex 0.40.0')",
  authScript = 'process.exit(0)',
): CliProbeContract {
  return {
    version: {
      command: ['node', '-e', versionScript],
      cwd: 'neutral',
      timeoutMs: 1_000,
      maxOutputBytes: 1_024,
    },
    auth: {
      command: ['node', '-e', authScript],
      cwd: 'neutral',
      timeoutMs: 1_000,
      maxOutputBytes: 1_024,
    },
  };
}

describe('CLI readiness probe', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('fails closed before probing when the trusted executable identity drifts', async () => {
    const identity = await nodeExecutable();
    const result = await probeCliReadiness({
      tool: 'codex',
      executable: {
        path: identity.path,
        fingerprint: {
          ...identity.fingerprint,
          size: identity.fingerprint.size + 1,
        },
      },
      probe: probe(),
    });

    expect(result.status).toBe('untrusted');
  });

  it('fails closed on Windows before spawning a probe or its descendants', async () => {
    await withTempDir('readiness-probe-windows', async (directory) => {
      const executable = await nodeExecutable();
      const leaderMarker = join(directory, 'leader.spawned');
      const descendantMarker = join(directory, 'descendant.spawned');
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

      try {
        await expect(
          probeCliReadiness({
            tool: 'codex',
            executable,
            probe: {
              ...probe(),
              version: {
                command: [
                  'node',
                  '-e',
                  [
                    'const { spawn } = require("node:child_process");',
                    `const child = spawn(process.execPath, ["-e", ${JSON.stringify(`require("node:fs").writeFileSync(${JSON.stringify(descendantMarker)}, "descendant")`)}], { stdio: "ignore" });`,
                    `require("node:fs").writeFileSync(${JSON.stringify(leaderMarker)}, String(child.pid));`,
                  ].join(' '),
                ],
                cwd: 'neutral',
                timeoutMs: 250,
                maxOutputBytes: 1_024,
              },
            },
          }),
        ).rejects.toMatchObject({
          kind: 'platform-limitation',
          data: { operation: 'verify-absence', target: 'process-group', signal: null },
        });
        expect(existsSync(leaderMarker)).toBe(false);
        expect(existsSync(descendantMarker)).toBe(false);
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
      }
    });
  });

  it('requires explicit auth classification before reporting a successful probe as ready', async () => {
    const executable = await nodeExecutable();
    vi.stubEnv('OPENAI_API_KEY', 'readiness-test-key');
    const options = {
      tool: 'codex',
      executable,
      probe: probe(),
      authChannel: 'api-key',
    } as const;

    const unclassified = await probeCliReadiness(options);
    const classified = await probeCliReadiness({
      ...options,
      classifyAuth: () => 'authenticated',
    });

    expect(unclassified).toMatchObject({ auth: 'unknown', status: 'unverified' });
    expect(classified).toMatchObject({ auth: 'authenticated', status: 'ready' });
  });

  it('reaps a hanging probe before returning an unverified result', async () => {
    const executable = await nodeExecutable();
    const startedAt = Date.now();
    const result = await probeCliReadiness({
      tool: 'codex',
      executable,
      probe: probe("process.on('SIGTERM', () => {}); setInterval(() => {}, 1_000)"),
    });

    expect(result.status).toBe('unverified');
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1_900);
  }, 5_000);

  it.runIf(process.platform !== 'win32')(
    'settles when a descendant escapes the probe group holding the inherited pipes',
    async () => {
      const executable = await nodeExecutable();
      const result = await probeCliReadiness({
        tool: 'codex',
        executable,
        // The descendant starts its own session, so the group kill cannot reach
        // it and the leader's stdio never closes: the probe must still answer.
        probe: probe(
          [
            'const { spawn } = require("node:child_process");',
            'const escaped = spawn(process.execPath, ["-e", "setTimeout(() => process.exit(0), 4_000)"], { detached: true, stdio: ["ignore", "inherit", "inherit"] });',
            'escaped.unref();',
            'setInterval(() => {}, 1_000);',
          ].join(' '),
        ),
      });

      expect(result.status).toBe('unverified');
    },
    10_000,
  );

  it.runIf(process.platform !== 'win32')(
    'propagates a termination platform limitation without an unhandled rejection',
    async () => {
      await withTempDir('readiness-probe-platform', async (directory) => {
        const executable = await nodeExecutable();
        const pidFile = join(directory, 'probe.pid');
        const originalKill = process.kill;
        const signalCause: NodeJS.ErrnoException = new Error('signal unavailable');
        signalCause.code = 'EPERM';
        let rejectedSignal = false;
        // Under full-suite CPU load the child may not have written pidFile before the
        // 250ms timeout fires, so the predicate must not depend on reading it back:
        // within this test's window, any process-group SIGTERM is the one under test.
        const processKill = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
          if (!rejectedSignal && typeof pid === 'number' && pid < 0 && signal === 'SIGTERM') {
            rejectedSignal = true;
            throw signalCause;
          }
          return originalKill(pid, signal);
        });

        try {
          await expect(
            probeCliReadiness({
              tool: 'codex',
              executable,
              probe: {
                ...probe(),
                version: {
                  command: [
                    'node',
                    '-e',
                    `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1_000)`,
                  ],
                  cwd: 'neutral',
                  timeoutMs: 250,
                  maxOutputBytes: 1_024,
                },
              },
            }),
          ).rejects.toMatchObject({
            kind: 'platform-limitation',
            data: { operation: 'signal', target: 'process-group', signal: 'SIGTERM' },
            cause: signalCause,
          });
        } finally {
          processKill.mockRestore();
          try {
            process.kill(-Number.parseInt(readFileSync(pidFile, 'utf8'), 10), 'SIGKILL');
          } catch {}
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      });
    },
    3_000,
  );

  it.runIf(process.platform !== 'win32')(
    'reaps the probe group when a successful leader exits before its descendant',
    async () => {
      const executable = await nodeExecutable();
      vi.stubEnv('OPENAI_API_KEY', 'readiness-test-key');
      let descendantPid = 0;
      const startedAt = Date.now();
      const result = await probeCliReadiness({
        tool: 'codex',
        executable,
        authChannel: 'api-key',
        probe: {
          ...probe(),
          auth: {
            command: [
              'node',
              '-e',
              [
                'const { spawn } = require("node:child_process");',
                'const descendant = spawn(process.execPath, ["-e", `process.on("SIGTERM", () => {}); process.stdout.write("ready"); setInterval(() => {}, 1000)`], { stdio: ["ignore", "pipe", "ignore"] });',
                'descendant.stdout.once("data", () => { process.stdout.write(String(descendant.pid)); process.exit(0); });',
                'descendant.unref();',
              ].join(' '),
            ],
            cwd: 'neutral',
            timeoutMs: 5_000,
            maxOutputBytes: 1_024,
          },
        },
        classifyAuth: ({ stdout }) => {
          descendantPid = Number.parseInt(stdout, 10);
          return 'authenticated';
        },
      });

      expect(result.status).toBe('ready');
      expect(descendantPid).toBeGreaterThan(1);
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1_900);
      expect(() => process.kill(descendantPid, 0)).toThrow(
        expect.objectContaining({ code: 'ESRCH' }),
      );
    },
    5_000,
  );

  it('does not promote ambient credentials without a selected auth channel', async () => {
    const executable = await nodeExecutable();
    vi.stubEnv('OPENAI_API_KEY', 'ambient-key');

    const result = await probeCliReadiness({
      tool: 'codex',
      executable,
      probe: probe(),
      classifyAuth: () => 'authenticated',
    });

    expect(result).toMatchObject({ auth: 'unknown', status: 'unverified' });
  });

  it('passes only the selected API-key channel and blocks when its credential is missing', async () => {
    const executable = await nodeExecutable();
    const authScript = "process.exit(process.env.OPENAI_API_KEY === 'readiness-key' ? 0 : 1)";
    vi.stubEnv('OPENAI_API_KEY', 'readiness-key');

    const authenticated = await probeCliReadiness({
      tool: 'codex',
      executable,
      authChannel: 'api-key',
      probe: probe(undefined, authScript),
      classifyAuth: ({ exitCode }) => (exitCode === 0 ? 'authenticated' : 'unauthenticated'),
    });
    expect(authenticated.status).toBe('ready');

    vi.stubEnv('OPENAI_API_KEY', '');
    const missing = await probeCliReadiness({
      tool: 'codex',
      executable,
      authChannel: 'api-key',
      probe: probe(undefined, authScript),
      classifyAuth: () => 'authenticated',
    });
    expect(missing).toMatchObject({ auth: 'unauthenticated', status: 'unauthenticated' });
  });

  it('bridges only an allowlisted session snapshot and never exposes the host home', async () => {
    await withTempDir('readiness-session-state', async (hostHome) => {
      const executable = await nodeExecutable();
      await mkdir(join(hostHome, '.codex'), { recursive: true });
      await writeFile(join(hostHome, '.codex', 'auth.json'), '{"session":"fixture"}');
      vi.stubEnv('HOME', hostHome);
      vi.stubEnv('OPENAI_API_KEY', 'ambient-key');
      const authScript = [
        'const fs = require("node:fs");',
        'const path = require("node:path");',
        `const hostHome = ${JSON.stringify(hostHome)};`,
        'const isolatedHome = process.env.HOME;',
        'const hasSnapshot = isolatedHome !== hostHome &&',
        '  typeof isolatedHome === "string" &&',
        '  fs.existsSync(path.join(isolatedHome, ".codex", "auth.json"));',
        'process.exit(hasSnapshot && !process.env.OPENAI_API_KEY ? 0 : 1);',
      ].join(' ');

      const result = await probeCliReadiness({
        tool: 'codex',
        executable,
        authChannel: 'session',
        probe: probe(undefined, authScript),
        classifyAuth: ({ exitCode }) => (exitCode === 0 ? 'authenticated' : 'unauthenticated'),
      });

      expect(result.status).toBe('ready');
    });
  });

  it('does not promote a selected session channel when no allowlisted state exists', async () => {
    await withTempDir('readiness-session-empty', async (hostHome) => {
      const executable = await nodeExecutable();
      vi.stubEnv('HOME', hostHome);

      const result = await probeCliReadiness({
        tool: 'codex',
        executable,
        authChannel: 'session',
        probe: probe(undefined, 'process.exit(0)'),
        classifyAuth: () => 'authenticated',
      });

      expect(result).toMatchObject({ auth: 'unauthenticated', status: 'unauthenticated' });
    });
  });

  it('keeps a credentialed probe failure unauthenticated even if its classifier lies', async () => {
    const executable = await nodeExecutable();
    vi.stubEnv('OPENAI_API_KEY', 'readiness-key');

    const result = await probeCliReadiness({
      tool: 'codex',
      executable,
      authChannel: 'api-key',
      probe: probe(undefined, 'process.exit(1)'),
      classifyAuth: () => 'authenticated',
    });

    expect(result).toMatchObject({ auth: 'unauthenticated', status: 'unauthenticated' });
  });
});
