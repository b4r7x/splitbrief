import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdir, realpath, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CliExecutableIdentity } from '../../../core/discovery/detection.js';
import {
  capabilityTuple,
  unverifiedConformanceProof,
} from '#testing/helpers/factories/compiler-capability.js';
import { withTempDir } from '#testing/helpers/temp-dir.js';
import type { AuthFact } from '../../../core/discovery/runner-evidence.js';
import {
  isDeclaredCliProbeContract,
  type CliProbeContract,
  type CliProbeOutput,
} from './contract.js';
import { probeCliReadiness, probeDeclaredCliReadinessEvidence } from './readiness-probe.js';
import { resolveCliExecutable } from '../resolve-cli-executable.js';
import { admitCompilerCapability } from '../compiler-capability.js';

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

function declaredProbe(
  options: {
    versionScript?: string;
    authScript?: string;
    authCommand?: readonly [string, ...string[]];
    catalogScript?: string;
    parseAuth?: (input: CliProbeOutput) => AuthFact;
    authNotRun?: boolean;
  } = {},
): CliProbeContract {
  const version = {
    command: ['node', '-e', options.versionScript ?? "console.log('codex 0.40.0')"] as const,
    cwd: 'neutral' as const,
    timeoutMs: 1_000,
    maxOutputBytes: 1_024,
  };
  const auth = {
    command:
      options.authCommand ??
      (['node', '-e', options.authScript ?? "console.log('verified')"] as const),
    cwd: 'neutral' as const,
    timeoutMs: 1_000,
    maxOutputBytes: 1_024,
  };
  const catalog = {
    command: ['node', '-e', options.catalogScript ?? "console.log('model-a')"] as const,
    cwd: 'neutral' as const,
    timeoutMs: 1_000,
    maxOutputBytes: 1_024,
  };
  return {
    version,
    auth,
    declared: {
      kind: 'declared',
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

  it('does not infer authentication from a version command or credential presence', async () => {
    const executable = await nodeExecutable();
    vi.stubEnv('OPENAI_API_KEY', 'readiness-test-key');
    const legacyOptions = {
      tool: 'codex',
      executable,
      probe: probe(),
      authChannel: 'api-key',
    } as const;

    const legacy = await probeCliReadiness(legacyOptions);
    const declared = await probeCliReadiness({
      ...legacyOptions,
      probe: declaredProbe(),
    });

    expect(legacy).toMatchObject({ auth: 'unknown', status: 'unverified' });
    expect(declared).toMatchObject({ auth: 'authenticated', status: 'ready' });
  });

  it.runIf(process.platform !== 'win32')(
    'returns only readiness facts when a direct caller attaches catalog-like fields',
    async () => {
      await withTempDir('readiness-only-direct', async (directory) => {
        const authMarker = join(directory, 'auth-ran');
        const catalogMarker = join(directory, 'catalog-ran');
        const secret = 'readiness-only-selected-key';
        const executable = await resolveCliExecutable(process.execPath, directory);
        const probe = declaredProbe({
          authScript: [
            'const fs = require("node:fs");',
            `fs.writeFileSync(${JSON.stringify(authMarker)}, process.env.OPENAI_API_KEY === ${JSON.stringify(secret)} ? "selected" : "wrong");`,
            'process.stdout.write("verified");',
          ].join(' '),
          catalogScript: [
            'const fs = require("node:fs");',
            `fs.writeFileSync(${JSON.stringify(catalogMarker)}, process.env.OPENAI_API_KEY ?? "missing");`,
            'process.stdout.write("model-must-not-run");',
          ].join(' '),
        });
        if (!isDeclaredCliProbeContract(probe)) return;
        vi.stubEnv('OPENAI_API_KEY', secret);

        const direct = {
          tool: 'codex' as const,
          executable,
          probe: probe.declared,
          authChannel: 'api-key' as const,
          includeCatalog: true,
          catalogRefresh: 'manual',
        };
        const result = await probeDeclaredCliReadinessEvidence(direct);

        expect(result).toEqual({
          version: { kind: 'success', value: '0.40.0' },
          auth: 'verified',
        });
        expect(existsSync(authMarker)).toBe(true);
        expect(readFileSync(authMarker, 'utf8')).toBe('selected');
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
        vi.stubEnv('OPENAI_API_KEY', 'readiness-test-key');

        const exact = await probeCliReadiness({
          tool: 'codex',
          executable,
          authChannel: 'api-key',
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
            authChannel: 'api-key',
            probe: declaredProbe({ authCommand }),
          });
          expect(rejected.auth).toBe('not-checked');
        }
        expect(existsSync(rejectedMarker)).toBe(false);
      });
    },
  );

  // Atomic catalog coverage belongs to the detector-path tests.
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
    'reaps a caller-cancelled probe group and its descendant',
    async () => {
      await withTempDir('readiness-probe-cancelled', async (directory) => {
        const executable = await nodeExecutable();
        const descendantPidFile = join(directory, 'cancelled-descendant.pid');
        const controller = new AbortController();
        const pending = probeCliReadiness({
          tool: 'codex',
          executable,
          signal: controller.signal,
          probe: probe(
            [
              'const { spawn } = require("node:child_process");',
              `const child = spawn(process.execPath, ["-e", ${JSON.stringify(`require("node:fs").writeFileSync(${JSON.stringify(descendantPidFile)}, String(process.pid)); process.on("SIGTERM", () => {}); setInterval(() => {}, 1_000)`)}], { stdio: "ignore" });`,
              'child.unref();',
              'setInterval(() => {}, 1_000);',
            ].join(' '),
          ),
        });

        await vi.waitFor(() => expect(existsSync(descendantPidFile)).toBe(true));
        controller.abort();

        await expect(pending).rejects.toThrow(/abort/i);
        const descendantPid = Number.parseInt(readFileSync(descendantPidFile, 'utf8'), 10);
        expect(() => process.kill(descendantPid, 0)).toThrow(
          expect.objectContaining({ code: 'ESRCH' }),
        );
      });
    },
    5_000,
  );

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
    'reaps a timed-out probe group and its descendant',
    async () => {
      await withTempDir('readiness-probe-descendant', async (directory) => {
        const executable = await nodeExecutable();
        const pidFile = join(directory, 'descendant.pid');
        vi.stubEnv('OPENAI_API_KEY', 'readiness-test-key');
        const startedAt = Date.now();
        const result = await probeCliReadiness({
          tool: 'codex',
          executable,
          authChannel: 'api-key',
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
    const authScript =
      "process.stdout.write(process.env.OPENAI_API_KEY === 'readiness-key' ? 'verified' : 'invalid')";
    vi.stubEnv('OPENAI_API_KEY', 'readiness-key');

    const authenticated = await probeCliReadiness({
      tool: 'codex',
      executable,
      authChannel: 'api-key',
      probe: declaredProbe({ authScript }),
    });
    expect(authenticated.status).toBe('ready');

    vi.stubEnv('OPENAI_API_KEY', '');
    const missing = await probeCliReadiness({
      tool: 'codex',
      executable,
      authChannel: 'api-key',
      probe: declaredProbe({ authScript }),
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
        'process.stdout.write(hasSnapshot && !process.env.OPENAI_API_KEY ? "verified" : "invalid");',
      ].join(' ');

      const result = await probeCliReadiness({
        tool: 'codex',
        executable,
        authChannel: 'session',
        probe: declaredProbe({ authScript }),
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
        probe: declaredProbe(),
      });

      expect(result).toMatchObject({ auth: 'unauthenticated', status: 'unauthenticated' });
    });
  });

  it('does not promote a failed declared auth command when its parser claims verification', async () => {
    const executable = await nodeExecutable();
    vi.stubEnv('OPENAI_API_KEY', 'readiness-key');

    const result = await probeCliReadiness({
      tool: 'codex',
      executable,
      authChannel: 'api-key',
      probe: declaredProbe({
        authScript: 'process.exit(1)',
        parseAuth: () => 'verified',
      }),
    });

    expect(result).toMatchObject({ auth: 'unknown', status: 'unverified' });
  });

  it('a help-only binary is readiness-unverified and never admits compiler capability', async () => {
    const executable = await nodeExecutable();
    const result = await probeCliReadiness({
      tool: 'codex',
      executable,
      probe: declaredProbe({
        versionScript: "console.log('Usage: codex exec [OPTIONS]\\n  --json  Emit JSON output')",
        authNotRun: true,
      }),
    });

    expect(result.status).toBe('unverified');
    const admission = admitCompilerCapability(
      capabilityTuple('codex', { conformance: unverifiedConformanceProof() }),
    );
    expect(admission.kind).toBe('refused');
    if (admission.kind === 'refused') expect(admission.missing).toContain('conformance');
  });

  it('a readiness-ready result never admits compiler capability without a conformance proof', async () => {
    const executable = await nodeExecutable();
    vi.stubEnv('OPENAI_API_KEY', 'readiness-key');
    const result = await probeCliReadiness({
      tool: 'codex',
      executable,
      authChannel: 'api-key',
      probe: declaredProbe(),
      classifyVersion: () => 'compatible',
    });
    expect(result.status).toBe('ready');

    const admission = admitCompilerCapability(
      capabilityTuple('codex', { conformance: unverifiedConformanceProof() }),
    );
    expect(admission.kind).toBe('refused');
    if (admission.kind === 'refused') expect(admission.missing).toContain('conformance');
  });
});
