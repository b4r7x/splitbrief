import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdir, realpath, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CliExecutableIdentity } from '../../../../core/discovery/detection/executable.js';
import { CLI_TOOL_CATALOG } from '../../../../core/runners/cli-tool/catalog.js';
import type { CliReadinessResult } from '../../../../core/schemas/readiness.js';
import { expireDeadlineAfterFile, freezeProbeDeadlines } from '#testing/helpers/fake-timers.js';
import { itUnix } from '#testing/helpers/planner-command-invoke.js';
import { withTempDir } from '#testing/helpers/temp-dir.js';
import { stubSignInHome } from '#testing/helpers/sign-in-home.js';
import type { AuthFact } from '../../../../core/discovery/runner-evidence.js';
import type { CliDeclaredProbeContract, CliProbeOutput } from './contract.js';
import { providerOracleAuthFact } from './provider-oracle.js';
import { probeCliReadiness } from './readiness.js';
import { probeDeclaredCliReadinessEvidence } from './declared-readiness.js';
import { lookupCliReadinessProbe } from '../registry.js';
import { resolveCliExecutable } from '../../cli-executable/resolve.js';

/** A case whose child never answers on a real clock sets a short probe limit here. */
const probeLimit = vi.hoisted(() => ({ ms: undefined as number | undefined }));

vi.mock('../../../constants.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../constants.js')>();
  return {
    ...actual,
    get CLI_PROBE_TIMEOUT_MS() {
      return probeLimit.ms ?? actual.CLI_PROBE_TIMEOUT_MS;
    },
  };
});

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

/** A HOME that holds a Codex sign-in file, so the session status command runs on every platform. */
async function stubCodexSessionHome(directory: string): Promise<void> {
  const home = join(directory, 'home');
  await mkdir(join(home, '.codex'), { recursive: true });
  await writeFile(join(home, '.codex', 'auth.json'), '{"session":"fixture"}');
  vi.stubEnv('HOME', home);
  vi.stubEnv('CODEX_HOME', '');
}

function declaredProbe(
  options: {
    versionScript?: string;
    authScript?: string;
    authCommand?: readonly [string, ...string[]];
    catalogScript?: string;
    parseAuth?: (input: CliProbeOutput) => AuthFact;
    authNotRun?: boolean;
  } = {},
): CliDeclaredProbeContract {
  const version = {
    command: ['node', '-e', options.versionScript ?? "console.log('codex 0.40.0')"] as const,
    cwd: 'neutral' as const,
    maxOutputBytes: 1_024,
  };
  const auth = {
    command:
      options.authCommand ??
      (['node', '-e', options.authScript ?? "console.log('verified')"] as const),
    cwd: 'neutral' as const,
    maxOutputBytes: 1_024,
  };
  const catalog = {
    command: ['node', '-e', options.catalogScript ?? "console.log('model-a')"] as const,
    cwd: 'neutral' as const,
    maxOutputBytes: 1_024,
  };
  return {
    version: {
      ...version,
      kind: 'version',
      parse: ({ stdout }) =>
        stdout.includes('0.40.0') ? { kind: 'success', value: '0.40.0' } : { kind: 'malformed' },
    },
    auth: options.authNotRun
      ? { kind: 'not-run' }
      : {
          ...auth,
          kind: 'auth-status',
          parse:
            options.parseAuth ??
            (({ stdout }) => {
              const state = stdout.trim();
              if (state === 'verified') return 'verified';
              if (state === 'invalid') return 'invalid';
              if (state === 'unknown') return 'unknown';
              return 'malformed';
            }),
        },
    catalog: {
      ...catalog,
      kind: 'catalog',
      parse: ({ stdout }) => ({
        kind: 'success',
        value: stdout
          .trim()
          .split('\n')
          .filter((model) => model.length > 0)
          .map((id) => ({ id })),
      }),
    },
  };
}

const ORACLE_READ_OUTPUT = 'Credentials\nanthropic  oauth\n1 credential\n';
const ORACLE_EMPTY_OUTPUT = 'Credentials\n0 credentials\n';
const OPENCODE_TESTED_VERSION = CLI_TOOL_CATALOG.opencode.compatibility.testedVersion;

async function fakeOpencode(dir: string, oracleBody: string): Promise<CliExecutableIdentity> {
  const path = join(await realpath(dir), 'opencode');
  await writeFile(
    path,
    [
      '#!/usr/bin/env node',
      'const args = process.argv.slice(2);',
      `if (args[0] === '--version') { process.stdout.write('opencode ${OPENCODE_TESTED_VERSION}'); process.exit(0); }`,
      oracleBody,
    ].join('\n'),
  );
  await chmod(path, 0o755);
  const info = await stat(path);
  return {
    path,
    fingerprint: { dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs },
  };
}

function opencodeProbe(options: { authNotRun?: boolean } = {}): CliDeclaredProbeContract {
  const version = {
    command: ['opencode', '--version'] as const,
    cwd: 'neutral' as const,
    maxOutputBytes: 1_024,
  };
  const auth = {
    command: ['opencode', 'auth', 'list', '--standalone', '--format', 'json'] as const,
    cwd: 'neutral' as const,
    maxOutputBytes: 1_024,
  };
  return {
    version: {
      ...version,
      kind: 'version',
      parse: ({ stdout }) =>
        stdout.includes(OPENCODE_TESTED_VERSION)
          ? { kind: 'success', value: OPENCODE_TESTED_VERSION }
          : { kind: 'malformed' },
    },
    auth: options.authNotRun
      ? { kind: 'not-run' }
      : { ...auth, kind: 'auth-status', parse: providerOracleAuthFact },
    catalog: {
      command: ['opencode', 'models'] as const,
      cwd: 'neutral' as const,
      maxOutputBytes: 1_024,
      kind: 'catalog',
      parse: () => ({ kind: 'success', value: [] }),
    },
  };
}

async function probeOpencode(
  options: Readonly<{
    oracleBody?: string;
    authNotRun?: boolean;
    classifyVersion?: () => 'compatible' | 'incompatible' | 'unverified';
  }>,
): Promise<CliReadinessResult> {
  return withTempDir('readiness-oracle', async (dir) => {
    const home = join(dir, 'home');
    await mkdir(join(home, '.config', 'opencode'), { recursive: true });
    await writeFile(join(home, '.config', 'opencode', 'auth.json'), '{}');
    vi.stubEnv('HOME', home);
    vi.stubEnv('XDG_CONFIG_HOME', join(home, '.config'));
    vi.stubEnv('XDG_DATA_HOME', join(home, '.local', 'share'));
    const executable = await fakeOpencode(dir, options.oracleBody ?? 'process.exit(0);');
    return probeCliReadiness({
      tool: 'opencode',
      executable,
      probe: opencodeProbe(
        options.authNotRun === undefined ? {} : { authNotRun: options.authNotRun },
      ),
      ...(options.classifyVersion === undefined
        ? {}
        : { classifyVersion: options.classifyVersion }),
    });
  });
}

/**
 * The provider-dependent case with no credential file on disk: whatever
 * readiness concludes, it concluded from the environment alone.
 */
async function probeOpencodeWithoutBridgedState(
  providerKey: string | undefined,
): Promise<CliReadinessResult> {
  return withTempDir('readiness-env-passthrough', async (dir) => {
    const home = join(dir, 'home');
    await mkdir(home, { recursive: true });
    vi.stubEnv('HOME', home);
    // opencode's bridged auth.json is sourced from all three roots, so leaving
    // the XDG pair on the host's values would let a real login reach the child.
    vi.stubEnv('XDG_CONFIG_HOME', join(home, 'xdg-config'));
    vi.stubEnv('XDG_DATA_HOME', join(home, 'xdg-data'));
    for (const key of Object.keys(process.env)) {
      if (key.endsWith('_API_KEY')) vi.stubEnv(key, '');
    }
    vi.stubEnv('FOO_API_KEY', providerKey ?? '');
    // Like the real listing, the fake names the provider only when its key reaches it.
    const executable = await fakeOpencode(
      dir,
      `process.stdout.write(process.env.FOO_API_KEY ? ${JSON.stringify(ORACLE_READ_OUTPUT)} : ${JSON.stringify(ORACLE_EMPTY_OUTPUT)}); process.exit(0);`,
    );
    return probeCliReadiness({
      tool: 'opencode',
      executable,
      probe: opencodeProbe(),
    });
  });
}

freezeProbeDeadlines();

describe('CLI readiness probe', () => {
  afterEach(() => {
    probeLimit.ms = undefined;
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
      probe: declaredProbe(),
    });

    expect(result.status).toBe('untrusted');
  });

  itUnix('lets a Copilot probe read the host package cache the launcher execs from', async () => {
    await withTempDir('readiness-probe-copilot-cache', async (directory) => {
      const executable = await nodeExecutable();
      await stubSignInHome(join(directory, 'home'), ['copilot', 'codex']);
      const hostCache = '/host-copilot-cache';
      vi.stubEnv('COPILOT_CACHE_HOME', hostCache);
      const versionScript = `console.log(process.env.COPILOT_CACHE_HOME === ${JSON.stringify(hostCache)} ? 'copilot 0.40.0' : 'copilot unseen')`;

      const copilot = await probeCliReadiness({
        tool: 'copilot',
        executable,
        probe: declaredProbe({ versionScript }),
      });
      const codex = await probeCliReadiness({
        tool: 'codex',
        executable,
        probe: declaredProbe({ versionScript }),
      });

      // Without it the probe reports the build embedded in the launcher, not the
      // one the user installed — a version and a model list nothing else agrees with.
      expect(copilot.installedVersion).toBe('0.40.0');
      expect(codex.installedVersion).toBeNull();
    });
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
            probe: declaredProbe({
              versionScript: [
                'const { spawn } = require("node:child_process");',
                `const child = spawn(process.execPath, ["-e", ${JSON.stringify(`require("node:fs").writeFileSync(${JSON.stringify(descendantMarker)}, "descendant")`)}], { stdio: "ignore" });`,
                `require("node:fs").writeFileSync(${JSON.stringify(leaderMarker)}, String(child.pid));`,
              ].join(' '),
            }),
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

  it('runs the sign-in check of the catalog channel of the tool', async () => {
    await withTempDir('readiness-probe-catalog-channel', async (directory) => {
      const executable = await nodeExecutable();
      const authMarker = join(directory, 'auth-ran');
      await stubCodexSessionHome(directory);

      const result = await probeCliReadiness({
        tool: 'codex',
        executable,
        probe: declaredProbe({
          authScript: `require('node:fs').writeFileSync(${JSON.stringify(authMarker)}, ''); process.stdout.write('verified');`,
        }),
      });

      expect(result).toMatchObject({
        auth: 'authenticated',
        status: 'ready',
      });
      expect(existsSync(authMarker)).toBe(true);
    });
  });

  it('reports a tool signed out on its catalog channel without running its sign-in check', async () => {
    await withTempDir('readiness-probe-catalog-channel-signed-out', async (directory) => {
      const executable = await nodeExecutable();
      const authMarker = join(directory, 'auth-ran');
      vi.stubEnv('HOME', join(directory, 'home'));
      vi.stubEnv('CODEX_HOME', '');
      const probe = declaredProbe({
        authScript: `require('node:fs').writeFileSync(${JSON.stringify(authMarker)}, ''); process.stdout.write('verified');`,
      });
      const evidence = await probeDeclaredCliReadinessEvidence({
        tool: 'codex',
        executable,
        probe,
      });

      expect(evidence).toEqual({ version: { kind: 'success', value: '0.40.0' }, auth: 'missing' });
      expect(existsSync(authMarker)).toBe(false);
    });
  });

  it.runIf(process.platform !== 'win32')(
    'returns only readiness facts when a direct caller attaches catalog-like fields',
    async () => {
      await withTempDir('readiness-only-direct', async (directory) => {
        const authMarker = join(directory, 'auth-ran');
        const catalogMarker = join(directory, 'catalog-ran');
        const executable = await resolveCliExecutable({
          command: process.execPath,
          projectDir: directory,
        });
        const probe = declaredProbe({
          authScript: [
            'const fs = require("node:fs");',
            `fs.writeFileSync(${JSON.stringify(authMarker)}, "ran");`,
            'process.stdout.write("verified");',
          ].join(' '),
          catalogScript: [
            'const fs = require("node:fs");',
            `fs.writeFileSync(${JSON.stringify(catalogMarker)}, "ran");`,
            'process.stdout.write("model-must-not-run");',
          ].join(' '),
        });
        await stubCodexSessionHome(directory);

        const direct = {
          tool: 'codex' as const,
          executable,
          probe,
          includeCatalog: true,
          catalogRefresh: 'manual',
        };
        const result = await probeDeclaredCliReadinessEvidence(direct);

        expect(result).toEqual({
          version: { kind: 'success', value: '0.40.0' },
          auth: 'verified',
        });
        expect(existsSync(authMarker)).toBe(true);
        expect(readFileSync(authMarker, 'utf8')).toBe('ran');
        expect(existsSync(catalogMarker)).toBe(false);
        expect(result).not.toHaveProperty('catalog');
      });
    },
  );

  it.runIf(process.platform !== 'win32')(
    'allows only the exact read-only Codex login status auth probe',
    async () => {
      await withTempDir('readiness-probe-login-status', async (directory) => {
        const executablePath = join(directory, 'codex');
        const exactMarker = join(directory, 'exact-login-status-ran');
        const rejectedMarker = join(directory, 'rejected-login-ran');
        await writeFile(
          executablePath,
          [
            '#!/usr/bin/env node',
            'const fs = require("node:fs");',
            'const args = process.argv.slice(2);',
            'if (args[0] === "-e") { process.stdout.write("codex 0.40.0"); process.exit(0); }',
            `if (args.join(" ") === "login status") { fs.writeFileSync(${JSON.stringify(exactMarker)}, "ran"); process.stdout.write("verified"); process.exit(0); }`,
            `if (args[0] === "login") { fs.writeFileSync(${JSON.stringify(rejectedMarker)}, "ran"); process.stdout.write("invalid"); process.exit(0); }`,
            'process.exit(1);',
          ].join('\n'),
          { mode: 0o700 },
        );
        await chmod(executablePath, 0o700);
        const path = await realpath(executablePath);
        const info = await stat(path);
        const executable = {
          path,
          fingerprint: {
            dev: info.dev,
            ino: info.ino,
            size: info.size,
            mtimeMs: info.mtimeMs,
          },
        };
        await stubCodexSessionHome(directory);

        const exact = await probeCliReadiness({
          tool: 'codex',
          executable,
          probe: declaredProbe({ authCommand: ['codex', 'login', 'status'] }),
        });
        expect(exact).toMatchObject({ auth: 'authenticated', status: 'ready' });
        expect(existsSync(exactMarker)).toBe(true);

        for (const authCommand of [
          ['codex', 'login'] as const,
          ['codex', 'login', 'status', '--json'] as const,
        ]) {
          const rejected = await probeCliReadiness({
            tool: 'codex',
            executable,
            probe: declaredProbe({ authCommand }),
          });
          expect(rejected.auth).toBe('authenticated');
        }
        expect(existsSync(rejectedMarker)).toBe(false);
      });
    },
  );

  it('reaps a hanging probe before returning an unverified result', async () => {
    vi.useRealTimers();
    probeLimit.ms = 250;
    const executable = await nodeExecutable();
    const startedAt = Date.now();
    const result = await probeCliReadiness({
      tool: 'codex',
      executable,
      probe: declaredProbe({
        versionScript: "process.on('SIGTERM', () => {}); setInterval(() => {}, 1_000)",
      }),
    });

    expect(result.status).toBe('unverified');
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1_900);
  });

  it.runIf(process.platform !== 'win32')(
    'reaps a caller-cancelled probe group and its descendant',
    async () => {
      vi.useRealTimers();
      await withTempDir('readiness-probe-cancelled', async (directory) => {
        const executable = await nodeExecutable();
        const descendantPidFile = join(directory, 'cancelled-descendant.pid');
        const controller = new AbortController();
        const pending = probeCliReadiness({
          tool: 'codex',
          executable,
          signal: controller.signal,
          probe: declaredProbe({
            versionScript: [
              'const { spawn } = require("node:child_process");',
              `const child = spawn(process.execPath, ["-e", ${JSON.stringify(`require("node:fs").writeFileSync(${JSON.stringify(descendantPidFile)}, String(process.pid)); process.on("SIGTERM", () => {}); setInterval(() => {}, 1_000)`)}], { stdio: "ignore" });`,
              'child.unref();',
              'setInterval(() => {}, 1_000);',
            ].join(' '),
          }),
        });

        await vi.waitFor(
          () => {
            expect(readFileSync(descendantPidFile, 'utf8').trim()).not.toBe('');
          },
          { interval: 25 },
        );
        controller.abort();

        await expect(pending).rejects.toThrow(/abort/i);
        const descendantPid = Number.parseInt(readFileSync(descendantPidFile, 'utf8'), 10);
        expect(() => process.kill(descendantPid, 0)).toThrow(
          expect.objectContaining({ code: 'ESRCH' }),
        );
      });
    },
  );

  it.runIf(process.platform !== 'win32')(
    'settles when a descendant escapes the probe group holding the inherited pipes',
    async () => {
      vi.useRealTimers();
      probeLimit.ms = 250;
      await withTempDir('readiness-escaped-descendant', async (directory) => {
        const release = join(directory, 'release');
        const exited = join(directory, 'exited');
        const executable = await nodeExecutable();
        // The descendant leaves when the test releases it (or after 4 s) and marks its exit.
        const descendant = `const fs = require("node:fs"); const leave = () => { fs.writeFileSync(${JSON.stringify(exited)}, ""); process.exit(0); }; setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) leave(); }, 25); setTimeout(leave, 4_000);`;
        const result = await probeCliReadiness({
          tool: 'codex',
          executable,
          // The descendant starts its own session, so the group kill cannot reach
          // it and the leader's stdio never closes: the probe must still answer.
          probe: declaredProbe({
            versionScript: [
              'const { spawn } = require("node:child_process");',
              `const escaped = spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], { detached: true, stdio: ["ignore", "inherit", "inherit"] });`,
              'escaped.unref();',
              'setInterval(() => {}, 1_000);',
            ].join(' '),
          }),
        });

        expect(result.status).toBe('unverified');
        expect(existsSync(exited)).toBe(false);
        await writeFile(release, '');
        await vi.waitFor(() => expect(existsSync(exited)).toBe(true));
      });
    },
  );

  it.runIf(process.platform !== 'win32')(
    'propagates a termination platform limitation without an unhandled rejection',
    async () => {
      vi.useRealTimers();
      probeLimit.ms = 250;
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
              probe: declaredProbe({
                versionScript: `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1_000)`,
              }),
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
    30_000,
  );

  it.runIf(process.platform !== 'win32')(
    'reaps a timed-out probe group and its descendant',
    async () => {
      vi.useRealTimers();
      await withTempDir('readiness-probe-descendant', async (directory) => {
        const executable = await nodeExecutable();
        const pidFile = join(directory, 'descendant.pid');
        await stubCodexSessionHome(directory);
        // Long enough for the grandchild to record its pid before the reap, on a machine
        // running the whole suite at once; the elapsed assertion below still holds.
        probeLimit.ms = 8_000;
        const startedAt = Date.now();
        const result = await probeCliReadiness({
          tool: 'codex',
          executable,
          probe: declaredProbe({
            authScript: [
              'const { spawn } = require("node:child_process");',
              `const descendant = spawn(process.execPath, ["-e", ${JSON.stringify(`require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.on("SIGTERM", () => {}); setInterval(() => {}, 1_000)`)}], { stdio: "ignore" });`,
              'descendant.unref();',
              'setInterval(() => {}, 1_000);',
            ].join(' '),
          }),
        });

        const descendantPid = Number.parseInt(readFileSync(pidFile, 'utf8'), 10);
        expect(result.status).toBe('unverified');
        expect(descendantPid).toBeGreaterThan(1);
        expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1_900);
        expect(() => process.kill(descendantPid, 0)).toThrow(
          expect.objectContaining({ code: 'ESRCH' }),
        );
      });
    },
  );

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
        'process.stdout.write(hasSnapshot && !process.env.OPENAI_API_KEY ? "verified" : "invalid");',
      ].join(' ');

      const result = await probeCliReadiness({
        tool: 'codex',
        executable,
        probe: declaredProbe({ authScript }),
      });

      expect(result.status).toBe('ready');
    });
  });

  it('does not promote a session channel when no allowlisted state exists', async () => {
    await withTempDir('readiness-session-empty', async (hostHome) => {
      const executable = await nodeExecutable();
      vi.stubEnv('HOME', hostHome);

      const result = await probeCliReadiness({
        tool: 'codex',
        executable,
        probe: declaredProbe(),
      });

      expect(result).toMatchObject({ auth: 'unauthenticated', status: 'unauthenticated' });
    });
  });

  it('does not promote a failed declared auth command when its parser claims verification', async () => {
    await withTempDir('readiness-probe-failed-auth', async (directory) => {
      const executable = await nodeExecutable();
      await stubCodexSessionHome(directory);

      const result = await probeCliReadiness({
        tool: 'codex',
        executable,
        probe: declaredProbe({
          authScript: 'process.exit(1)',
          parseAuth: () => 'verified',
        }),
      });

      expect(result).toMatchObject({ auth: 'unknown', status: 'unverified' });
    });
  });

  it('a help-only binary is readiness-unverified', async () => {
    await withTempDir('readiness-probe-help-only', async (directory) => {
      const executable = await nodeExecutable();
      await stubCodexSessionHome(directory);
      const result = await probeCliReadiness({
        tool: 'codex',
        executable,
        probe: declaredProbe({
          versionScript: "console.log('Usage: codex exec [OPTIONS]\\n  --json  Emit JSON output')",
          authNotRun: true,
        }),
      });

      expect(result.status).toBe('unverified');
    });
  });

  describe('provider credential oracle', () => {
    itUnix('reads the listed provider credentials', async () => {
      const result = await probeOpencode({
        oracleBody: `process.stdout.write(${JSON.stringify(ORACLE_READ_OUTPUT)}); process.exit(0);`,
      });

      expect(result.providerAuth).toEqual({
        kind: 'read',
        facts: [{ provider: 'anthropic', source: 'oauth' }],
      });
    });

    itUnix('reports a clean zero listing as signed in to nothing', async () => {
      const result = await probeOpencode({
        oracleBody: `process.stdout.write(${JSON.stringify(ORACLE_EMPTY_OUTPUT)}); process.exit(0);`,
      });

      expect(result.providerAuth).toEqual({ kind: 'empty' });
    });

    itUnix('names an unreadable listing a parse failure', async () => {
      const result = await probeOpencode({
        oracleBody: "process.stdout.write('surprise new format'); process.exit(0);",
      });

      expect(result.providerAuth).toEqual({ kind: 'unreadable', reason: 'parse-failure' });
    });

    itUnix('names a failed oracle command an exit failure', async () => {
      const result = await probeOpencode({ oracleBody: 'process.exit(1);' });

      expect(result.providerAuth).toEqual({ kind: 'unreadable', reason: 'exit-failure' });
    });

    itUnix('names a hanging oracle command a timeout', async () => {
      vi.useRealTimers();
      probeLimit.ms = 250;
      const result = await probeOpencode({
        oracleBody: 'setTimeout(() => process.exit(0), 5_000);',
      });

      expect(result.providerAuth).toEqual({ kind: 'unreadable', reason: 'timeout' });
    });

    itUnix('keeps the facts read under an unverified version', async () => {
      const result = await probeOpencode({
        oracleBody: `process.stdout.write(${JSON.stringify(ORACLE_READ_OUTPUT)}); process.exit(0);`,
        classifyVersion: () => 'unverified',
      });

      expect(result.status).toBe('unverified');
      expect(result.providerAuth).toEqual({
        kind: 'read',
        facts: [{ provider: 'anthropic', source: 'oauth' }],
      });
    });

    itUnix('reports a listing that never ran as not probed', async () => {
      const result = await probeOpencode({ authNotRun: true });

      expect(result.providerAuth).toEqual({ kind: 'unreadable', reason: 'not-probed' });
    });

    itUnix(
      'blames the version for a listing that never ran on an incompatible version',
      async () => {
        const result = await probeOpencode({
          authNotRun: true,
          classifyVersion: () => 'incompatible',
        });

        expect(result.providerAuth).toEqual({ kind: 'unreadable', reason: 'version-mismatch' });
      },
    );

    itUnix('downgrades auth to not-checked on an incompatible version', async () => {
      const compatible = await probeOpencode({ classifyVersion: () => 'compatible' });
      const incompatible = await probeOpencode({ classifyVersion: () => 'incompatible' });

      expect(compatible.auth).toBe('authenticated');
      expect(incompatible.auth).toBe('not-checked');
    });
  });

  describe('provider key from the shell environment', () => {
    itUnix('verifies a provider key that lives only in the shell environment', async () => {
      const result = await probeOpencodeWithoutBridgedState('shell-only');

      expect(result.auth).toBe('authenticated');
      expect(result.status).toBe('ready');
      expect(result.providerAuth).toEqual({
        kind: 'read',
        facts: [{ provider: 'anthropic', source: 'oauth' }],
      });
    });

    itUnix('reports unauthenticated when the key is absent everywhere', async () => {
      const result = await probeOpencodeWithoutBridgedState(undefined);

      expect(result.auth).toBe('unauthenticated');
      expect(result.status).toBe('unauthenticated');
      expect(result.providerAuth).toEqual({ kind: 'empty' });
    });

    itUnix('still reports a bridged credential file as authenticated', async () => {
      const result = await probeOpencode({
        oracleBody: `process.stdout.write(${JSON.stringify(ORACLE_READ_OUTPUT)}); process.exit(0);`,
      });

      expect(result.auth).toBe('authenticated');
    });
  });

  itUnix(
    'gives a version check that never answers one minute before it times out',
    async () => {
      await withTempDir('readiness-probe-version-ceiling', async (directory) => {
        const versionStarted = join(directory, 'version-started');
        const script = join(directory, 'codex');
        await writeFile(
          script,
          [
            '#!/bin/sh',
            'if [ "$1" = "--version" ]; then',
            `  : > ${JSON.stringify(versionStarted)}`,
            '  exec tail -f /dev/null',
            'fi',
            'exit 1',
            '',
          ].join('\n'),
        );
        await chmod(script, 0o755);
        const executable = await resolveCliExecutable({
          command: script,
          projectDir: '/neutral/project',
        });
        await stubSignInHome(join(directory, 'home'), []);
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
        const armedAt = Date.now();

        const pending = probeCliReadiness({
          tool: 'codex',
          executable,
          probe: lookupCliReadinessProbe({ tool: 'codex', role: 'planner' }),
        });
        await expireDeadlineAfterFile(versionStarted);

        expect(Date.now() - armedAt).toBe(60_000);
        expect(await pending).toMatchObject({ installedVersion: null });
      });
    },
    20_000,
  );

  itUnix('keeps a declared version check that timed out as a timeout', async () => {
    await withTempDir('readiness-probe-version-timeout', async (directory) => {
      vi.stubEnv('HOME', join(directory, 'home'));
      vi.stubEnv('CODEX_HOME', join(directory, 'home', '.codex'));
      const versionStarted = join(directory, 'version-started');
      const script = join(directory, 'codex');
      await writeFile(
        script,
        [
          '#!/bin/sh',
          'if [ "$1" = "--version" ]; then',
          `  : > ${JSON.stringify(versionStarted)}`,
          '  exec tail -f /dev/null',
          'fi',
          'exit 1',
          '',
        ].join('\n'),
      );
      await chmod(script, 0o755);
      const executable = await resolveCliExecutable({
        command: script,
        projectDir: '/neutral/project',
      });

      const pending = probeCliReadiness({
        tool: 'codex',
        executable,
        probe: lookupCliReadinessProbe({ tool: 'codex', role: 'planner' }),
      });
      await expireDeadlineAfterFile(versionStarted);

      expect(await pending).toMatchObject({ installedVersion: null, compatibility: 'timeout' });
    });
  });

  it('keeps a sign-in check that timed out as a timeout', async () => {
    await withTempDir('readiness-probe-auth-timeout', async (directory) => {
      await stubCodexSessionHome(directory);
      const authStarted = join(directory, 'auth-started');
      const executable = await nodeExecutable();

      const pending = probeCliReadiness({
        tool: 'codex',
        executable,
        classifyVersion: () => 'compatible',
        probe: declaredProbe({
          authScript: `require('node:fs').writeFileSync(${JSON.stringify(authStarted)}, ''); setInterval(() => {}, 1_000)`,
        }),
      });
      await expireDeadlineAfterFile(authStarted);

      expect(await pending).toMatchObject({
        compatibility: 'compatible',
        auth: 'timeout',
        status: 'unverified',
      });
    });
  });
});

// Captured from `opencode auth list --standalone --format json` on opencode
// 2.0.12, 2026-09-21; credential record ids replaced with placeholders.
const OPENCODE_V2_AUTH_LIST_JSON = readFileSync(
  join(import.meta.dirname, '../../../../../testing/fixtures/opencode/auth-list-v2.json'),
  'utf8',
);
// Captured verbatim from `opencode auth list` on opencode 1.18.15, 2026-09-21.
const OPENCODE_V1_AUTH_LIST_OUTPUT =
  '\u001b[0m\n┌  Credentials \u001b[90m~/.local/share/opencode/auth.json\n│\n●  OpenAI \u001b[90moauth\n│\n●  OpenCode Go \u001b[90mapi\n│\n└  2 credentials\n\n┌  Environment\n│\n●  Ollama Cloud \u001b[90mOLLAMA_API_KEY\n│\n●  OpenAI \u001b[90mOPENAI_API_KEY\n│\n●  Kimi For Coding \u001b[90mKIMI_API_KEY\n│\n└  3 environment variables\n\n';

/**
 * What each opencode release does with the two listing argv: 2.x answers the
 * private-server JSON form and hangs on the plain one (a background service
 * it cannot start), 1.x rejects the private-server flag with its usage text.
 */
async function fakeOpencodeRelease(
  dir: string,
  release: Readonly<{ versionLine: string; major: 1 | 2 }>,
  log: string,
): Promise<CliExecutableIdentity> {
  const path = join(dir, 'opencode');
  const modernListing = `args.includes('--standalone') && args.includes('json') ? ${JSON.stringify(OPENCODE_V2_AUTH_LIST_JSON)} : null`;
  const legacyListing = `args.includes('--standalone') ? null : ${JSON.stringify(OPENCODE_V1_AUTH_LIST_OUTPUT)}`;
  await writeFile(
    path,
    [
      '#!/usr/bin/env node',
      'const args = process.argv.slice(2);',
      `require('node:fs').appendFileSync(${JSON.stringify(log)}, args.join(' ') + '\\n');`,
      `if (args[0] === '--version') { process.stdout.write(${JSON.stringify(`${release.versionLine}\n`)}); process.exit(0); }`,
      `const listing = ${release.major === 2 ? modernListing : legacyListing};`,
      "if (listing === null) { process.stderr.write('unsupported invocation\\n'); process.exit(1); }",
      'process.stdout.write(listing); process.exit(0);',
    ].join('\n'),
  );
  await chmod(path, 0o755);
  const info = await stat(path);
  return {
    path,
    fingerprint: { dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs },
  };
}

async function probeOpencodeRelease(release: Readonly<{ versionLine: string; major: 1 | 2 }>) {
  return withTempDir('readiness-opencode-release', async (dir) => {
    const root = await realpath(dir);
    const home = join(root, 'home');
    await mkdir(join(home, '.config', 'opencode'), { recursive: true });
    await writeFile(join(home, '.config', 'opencode', 'auth.json'), '{}');
    vi.stubEnv('HOME', home);
    vi.stubEnv('XDG_CONFIG_HOME', join(home, '.config'));
    vi.stubEnv('XDG_DATA_HOME', join(home, '.local', 'share'));
    const log = join(root, 'argv.log');
    const executable = await fakeOpencodeRelease(root, release, log);
    const probe = lookupCliReadinessProbe({ tool: 'opencode', role: 'planner' });
    const evidence = await probeDeclaredCliReadinessEvidence({
      tool: 'opencode',
      executable,
      probe,
    });
    return { evidence, argv: readFileSync(log, 'utf8').trim().split('\n') };
  });
}

describe('opencode oracle argv follows the installed release', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  itUnix('reads the 2.x JSON listing through a private server', async () => {
    const { evidence, argv } = await probeOpencodeRelease({
      versionLine: 'opencode v2.0.12',
      major: 2,
    });

    expect(evidence.version).toEqual({ kind: 'success', value: '2.0.12' });
    expect(argv).toEqual(['--version', 'auth list --standalone --format json']);
    expect(evidence.auth).toBe('verified');
    expect(evidence.providerAuth).toEqual({
      kind: 'read',
      facts: expect.arrayContaining([
        { id: 'opencode-go', provider: 'OpenCode Go', source: 'stored' },
        { id: 'openai', provider: 'OpenAI', source: 'env', envVar: 'OPENAI_API_KEY' },
      ]),
    });
  });

  itUnix(
    'keeps the boxed listing below 2.0.0, where the private-server flag is rejected',
    async () => {
      const { evidence, argv } = await probeOpencodeRelease({ versionLine: '1.18.15', major: 1 });

      expect(evidence.version).toEqual({ kind: 'success', value: '1.18.15' });
      expect(argv).toEqual(['--version', 'auth list']);
      expect(evidence.auth).toBe('verified');
      expect(evidence.providerAuth).toEqual({
        kind: 'read',
        facts: [
          { provider: 'OpenAI', source: 'oauth' },
          { provider: 'OpenCode Go', source: 'api' },
          { provider: 'Ollama Cloud', source: 'env', envVar: 'OLLAMA_API_KEY' },
          { provider: 'OpenAI', source: 'env', envVar: 'OPENAI_API_KEY' },
          { provider: 'Kimi For Coding', source: 'env', envVar: 'KIMI_API_KEY' },
        ],
      });
    },
  );
});
