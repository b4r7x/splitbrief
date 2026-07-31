import { describe, expect, it, vi } from 'vitest';
import type {
  CliExecutableIdentity,
  CliToolDetection,
  ProviderDetection,
} from '../../core/discovery/detection.js';
import { CLI_TOOL_CATALOG, CLI_TOOL_IDS } from '../../core/runners/cli-tool-catalog.js';
import { deriveCliReadiness } from '../../core/schemas/readiness.js';
import { error } from '../../utils/error.js';
import type { ProbeCliReadinessOptions } from '../runners/cli-tools/readiness-probe.js';
import { detectAll, detectAvailableCliReadiness, detectAvailableCliTools } from './detect.js';

const executable: CliExecutableIdentity = {
  path: '/trusted/bin/tool',
  fingerprint: { dev: 1, ino: 2, size: 3, mtimeMs: 4 },
};

describe('role-neutral CLI detection', () => {
  it('detects every catalog CLI once without planner construction', async () => {
    const resolveExecutable = vi.fn(async () => executable);
    const probeReadiness = vi.fn(async (options: ProbeCliReadinessOptions) => deriveProbe(options));

    const results = await detectAvailableCliTools({
      projectDir: '/neutral/project',
      resolveExecutable,
      probeReadiness,
      now: () => 1_700_000_000_000,
    });

    expect(results.map((result) => result.tool)).toEqual(CLI_TOOL_IDS);
    expect(resolveExecutable).toHaveBeenCalledTimes(CLI_TOOL_IDS.length);
    expect(probeReadiness).toHaveBeenCalledTimes(CLI_TOOL_IDS.length);
    for (const [index, tool] of CLI_TOOL_IDS.entries()) {
      expect(resolveExecutable).toHaveBeenNthCalledWith(
        index + 1,
        CLI_TOOL_CATALOG[tool].command,
        '/neutral/project',
      );
      expect(probeReadiness).toHaveBeenNthCalledWith(
        index + 1,
        expect.objectContaining({ tool, executable }),
      );
    }
  });

  it('forwards only explicitly selected auth channels to the probe boundary', async () => {
    const probeReadiness = vi.fn(async (options: ProbeCliReadinessOptions) => deriveProbe(options));

    await detectAvailableCliTools({
      resolveExecutable: async () => executable,
      probeReadiness,
      authChannels: { codex: 'api-key' },
      now: () => 42,
    });

    expect(probeReadiness).toHaveBeenCalledWith(
      expect.objectContaining({ tool: 'codex', authChannel: 'api-key' }),
    );
    for (const call of probeReadiness.mock.calls) {
      if (call[0].tool !== 'codex') expect(call[0].authChannel).toBeUndefined();
    }
  });

  it('cannot claim readiness from a probe result when no auth channel was selected', async () => {
    const [result] = await detectAvailableCliTools({
      resolveExecutable: async () => executable,
      probeReadiness: async (options) =>
        deriveCliReadiness({
          tool: options.tool,
          enabled: true,
          installation: 'installed',
          executable: options.executable,
          trust: 'trusted',
          installedVersion: CLI_TOOL_CATALOG[options.tool].compatibility.testedVersion,
          testedVersion: CLI_TOOL_CATALOG[options.tool].compatibility.testedVersion,
          compatibility: 'compatible',
          auth: 'authenticated',
          probedAt: options.now?.() ?? 42,
        }),
      now: () => 42,
    });

    expect(result).toMatchObject({ auth: 'unknown', diagnostic: { state: 'unverified' } });
  });

  it('keeps unknown authentication explicit and fails readiness closed', async () => {
    const [result] = await detectAvailableCliTools({
      resolveExecutable: async () => executable,
      probeReadiness: async (options) => deriveProbe(options),
      now: () => 42,
    });

    expect(result).toMatchObject({
      executable,
      trust: 'trusted',
      installedVersion: CLI_TOOL_CATALOG['claude-code'].compatibility.testedVersion,
      compatibility: 'compatible',
      auth: 'unknown',
      diagnostic: {
        state: 'unverified',
        remediation: expect.any(String),
      },
      probedAt: 42,
    });
  });

  it('retains major-version mismatch classification without claiming authentication', async () => {
    const [result] = await detectAvailableCliTools({
      resolveExecutable: async () => executable,
      probeReadiness: async (options) => {
        const testedVersion = CLI_TOOL_CATALOG[options.tool].compatibility.testedVersion;
        const installedVersion = `${Number(testedVersion.split('.')[0]) + 1}.0.0`;
        const compatibility =
          options.classifyVersion?.({ installedVersion, testedVersion }) ?? 'unverified';
        return deriveCliReadiness({
          tool: options.tool,
          enabled: true,
          installation: 'installed',
          executable: options.executable,
          trust: 'trusted',
          installedVersion,
          testedVersion,
          compatibility,
          auth: 'not-checked',
          probedAt: 43,
        });
      },
    });

    expect(result).toMatchObject({
      compatibility: 'incompatible',
      auth: 'unknown',
      diagnostic: { state: 'incompatible', remediation: expect.any(String) },
    });
  });

  it('reports unavailable and untrusted executable resolution separately', async () => {
    const unavailable = await detectAvailableCliTools({
      resolveExecutable: async () => {
        throw error('cli-executable-unavailable', 'not installed');
      },
      probeReadiness: async (options) => deriveProbe(options),
      now: () => 7,
    });
    const untrusted = await detectAvailableCliTools({
      resolveExecutable: async () => {
        throw error('cli-executable-untrusted', 'project-local shadow');
      },
      probeReadiness: async (options) => deriveProbe(options),
      now: () => 8,
    });

    for (const result of unavailable) {
      expect(result).toMatchObject({
        trust: 'not-checked',
        diagnostic: { state: 'unavailable', remediation: expect.any(String) },
        probedAt: 7,
      });
    }
    for (const result of untrusted) {
      expect(result).toMatchObject({
        trust: 'untrusted',
        diagnostic: { state: 'untrusted', remediation: expect.any(String) },
        probedAt: 8,
      });
    }
  });

  it('projects resolver trust failures as untrusted readiness', async () => {
    const [result] = await detectAvailableCliReadiness({
      tools: ['codex'],
      resolveExecutable: async () => {
        throw error('cli-executable-untrusted', 'project-local shadow');
      },
      probeReadiness: async (options) => deriveProbe(options),
      now: () => 9,
    });
    if (result === undefined) throw new Error('expected one readiness result');

    expect(result).toMatchObject({
      tool: 'codex',
      installation: 'installed',
      executable: null,
      trust: 'untrusted',
      status: 'untrusted',
      checkId: 'runners.cli.codex.readiness',
      remediation: expect.any(String),
      probedAt: 9,
    });
    expect(result.status).not.toBe('unavailable');
  });
});

describe('detectAll', () => {
  it('returns only canonical provider and role-neutral CLI collections', async () => {
    const providers: ProviderDetection[] = [{ provider: 'ollama', available: true, isLocal: true }];
    const cliTools: CliToolDetection[] = [
      {
        tool: 'codex',
        executable,
        trust: 'trusted',
        installedVersion: '0.40.0',
        testedVersion: '0.40.0',
        compatibility: 'compatible',
        auth: 'unknown',
        diagnostic: {
          state: 'unverified',
          remediation: 'Authenticate and verify the CLI before selecting it.',
        },
        probedAt: 1,
      },
    ];

    const result = await detectAll({
      detectProviders: async () => providers,
      detectCliTools: async () => cliTools,
    });

    expect(result).toEqual({ providers, cliTools });
    expect(result).not.toHaveProperty('planners');
    expect(result).not.toHaveProperty('implementers');
  });
});

function deriveProbe(options: ProbeCliReadinessOptions) {
  const testedVersion = CLI_TOOL_CATALOG[options.tool].compatibility.testedVersion;
  const compatibility = options.classifyVersion?.({
    installedVersion: testedVersion,
    testedVersion,
  });
  return deriveCliReadiness({
    tool: options.tool,
    enabled: true,
    installation: 'installed',
    executable: options.executable,
    trust: 'trusted',
    installedVersion: testedVersion,
    testedVersion,
    compatibility: compatibility ?? 'unverified',
    auth: 'not-checked',
    probedAt: options.now?.() ?? Date.now(),
  });
}
