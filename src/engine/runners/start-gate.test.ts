import { chmodSync, existsSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CliExecutableIdentity } from '../../core/discovery/detection.js';
import type { RunnerEvidence } from '../../core/discovery/runner-evidence.js';
import { CLI_TOOL_CATALOG, type CliToolId } from '../../core/runners/cli-tool-catalog.js';
import { error } from '../../utils/error.js';
import {
  admitFreshCliStart,
  cliStartGateFromReadiness,
  cliStartGatesFromArray,
  revalidateCliStartGates,
} from './start-gate.js';
import { deriveCliReadiness } from '../../core/schemas/readiness.js';
import { resolveCliExecutable } from './resolve-cli-executable.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';

const EXECUTABLE_CONTENT_DIGEST = 'a'.repeat(64);
const itUnix = process.platform === 'win32' ? it.skip : it;

const legacyExecutable: CliExecutableIdentity = {
  path: '/usr/local/bin/codex',
  fingerprint: { dev: 1, ino: 2, size: 3, mtimeMs: 4 },
};

type EvidenceOverrides = Readonly<{
  tool?: CliToolId;
  source?: RunnerEvidence['context']['source'];
  runnerId?: string;
  contextKey?: string;
  selectionId?: string;
  installation?: RunnerEvidence['installation'];
  executable?: RunnerEvidence['executable'];
  compatibility?: RunnerEvidence['compatibility'];
  auth?: RunnerEvidence['auth'];
}>;

function freshEvidence(overrides: EvidenceOverrides = {}): RunnerEvidence {
  const tool = overrides.tool ?? 'codex';
  const contextKey = overrides.contextKey ?? 'fresh-context';
  const testedVersion = CLI_TOOL_CATALOG[tool].compatibility.testedVersion;
  return {
    runner: {
      id: overrides.runnerId ?? tool,
      kind: 'cli',
      locality: 'local',
      enabled: 'enabled',
    },
    context: { key: contextKey, observedAt: 1, source: overrides.source ?? 'fresh' },
    installation: overrides.installation ?? 'installed',
    executable: overrides.executable ?? {
      kind: 'trusted',
      identity: {
        canonicalPath: `/usr/local/bin/${tool}`,
        realPath: `/usr/local/bin/${tool}`,
        platformFileId: '1:2',
        fingerprint: `1:2:3:4:sha256:${EXECUTABLE_CONTENT_DIGEST}`,
        resolvedAt: 1,
      },
    },
    compatibility: overrides.compatibility ?? {
      kind: 'compatible',
      installedVersion: testedVersion,
      testedVersion,
    },
    credential: 'present',
    auth: overrides.auth ?? 'verified',
    endpoint: { kind: 'not-run' },
    catalog: { kind: 'not-run' },
    modelRun: {
      kind: 'unknown',
      selectionId: overrides.selectionId ?? 'unselected',
      observedAt: 1,
      contextKey,
    },
  };
}

function admit(
  evidence: RunnerEvidence,
  overrides: Partial<
    Pick<Parameters<typeof admitFreshCliStart>[0], 'interaction' | 'unverifiedAuth'>
  > = {},
) {
  return admitFreshCliStart({
    tool: 'codex',
    evidence,
    expectedContextKey: 'fresh-context',
    expectedSelectionId: 'unselected',
    interaction: overrides.interaction ?? 'interactive',
    unverifiedAuth: overrides.unverifiedAuth ?? 'denied',
  });
}

describe('fresh CLI start gate', () => {
  it('rejects cached evidence even when every cached fact looks ready', () => {
    expect(admit(freshEvidence({ source: 'cached' }))).toEqual({
      kind: 'denied',
      reason: { kind: 'evidence-source', source: 'cached' },
    });
  });

  it('rejects evidence for a different configured runner identity', () => {
    expect(admit(freshEvidence({ runnerId: 'claude-code' }))).toEqual({
      kind: 'denied',
      reason: { kind: 'context-mismatch' },
    });
  });

  it('blocks a missing runner installation', () => {
    expect(admit(freshEvidence({ installation: 'missing' }))).toEqual({
      kind: 'denied',
      reason: { kind: 'installation', fact: 'missing' },
    });
  });

  it.each([
    ['missing executable', { kind: 'missing' }, { kind: 'executable', fact: 'missing' }],
    ['untrusted executable', { kind: 'untrusted' }, { kind: 'executable', fact: 'untrusted' }],
    [
      'identity drift',
      { kind: 'identity-drifted' },
      { kind: 'executable', fact: 'identity-drifted' },
    ],
  ] as const)('blocks %s before it can become an execution gate', (_label, executable, reason) => {
    expect(admit(freshEvidence({ executable }))).toEqual({ kind: 'denied', reason });
  });

  it.each([
    ['missing authentication', 'missing'],
    ['invalid authentication', 'invalid'],
    ['policy-denied authentication', 'policy-denied'],
  ] as const)('blocks %s', (_label, auth) => {
    expect(admit(freshEvidence({ auth }))).toEqual({
      kind: 'denied',
      reason: { kind: 'authentication', fact: auth },
    });
  });

  it('blocks an incompatible version', () => {
    const testedVersion = CLI_TOOL_CATALOG.codex.compatibility.testedVersion;
    expect(
      admit(
        freshEvidence({
          compatibility: {
            kind: 'incompatible',
            installedVersion: '0.0.0',
            testedVersion,
          },
        }),
      ),
    ).toEqual({ kind: 'denied', reason: { kind: 'compatibility', fact: 'incompatible' } });
  });

  it('requires an explicit interactive disclosure for compatibility auth unknown', () => {
    const evidence = freshEvidence({ tool: 'aider', auth: 'unknown' });
    const initial = admitFreshCliStart({
      tool: 'aider',
      evidence,
      expectedContextKey: 'fresh-context',
      expectedSelectionId: 'unselected',
      interaction: 'interactive',
      unverifiedAuth: 'denied',
    });
    const disclosed = admitFreshCliStart({
      tool: 'aider',
      evidence,
      expectedContextKey: 'fresh-context',
      expectedSelectionId: 'unselected',
      interaction: 'interactive',
      unverifiedAuth: 'disclosed',
    });

    expect(initial).toEqual({ kind: 'disclosure-required', auth: 'unknown' });
    expect(disclosed).toMatchObject({ kind: 'admitted', gate: { tool: 'aider' } });
  });

  it('does not let a disclosure silently bypass first-class unknown auth', () => {
    expect(admit(freshEvidence({ auth: 'unknown' }), { unverifiedAuth: 'disclosed' })).toEqual({
      kind: 'denied',
      reason: { kind: 'authentication-unverified' },
    });
  });

  it('requires an explicit headless allowance for unknown auth', () => {
    const evidence = freshEvidence({ tool: 'aider', auth: 'unknown' });
    const denied = admitFreshCliStart({
      tool: 'aider',
      evidence,
      expectedContextKey: 'fresh-context',
      expectedSelectionId: 'unselected',
      interaction: 'headless',
      unverifiedAuth: 'denied',
    });
    const allowed = admitFreshCliStart({
      tool: 'aider',
      evidence,
      expectedContextKey: 'fresh-context',
      expectedSelectionId: 'unselected',
      interaction: 'headless',
      unverifiedAuth: 'allowed',
    });

    expect(denied).toEqual({ kind: 'denied', reason: { kind: 'authentication-unverified' } });
    expect(allowed).toMatchObject({ kind: 'admitted', gate: { tool: 'aider' } });
  });

  it('revalidates the admitted identity before a session can be created', async () => {
    const gates = cliStartGatesFromArray([{ tool: 'codex', executable: legacyExecutable }]);

    await expect(
      revalidateCliStartGates({
        projectDir: '/project',
        gates,
        resolveExecutable: async () => {
          throw error('cli-executable-identity-drift', 'identity changed');
        },
      }),
    ).rejects.toMatchObject({ kind: 'cli-executable-identity-drift' });
  });

  it('does not turn a legacy stat-only receipt into fresh start authorization', () => {
    const evidence = freshEvidence({
      executable: {
        kind: 'trusted',
        identity: {
          canonicalPath: '/usr/local/bin/codex',
          realPath: '/usr/local/bin/codex',
          platformFileId: '1:2',
          fingerprint: '1:2:3:4',
          resolvedAt: 1,
        },
      },
    });

    expect(admit(evidence)).toEqual({
      kind: 'denied',
      reason: { kind: 'executable', fact: 'unknown' },
    });
  });

  itUnix('blocks metadata-preserving content replacement before session creation', async () => {
    const projectDir = createTempDir('start-gate-digest-project');
    const executableDir = createTempDir('start-gate-digest-executable');
    const executablePath = join(executableDir, 'codex');
    const markerPath = `${executablePath}.ran`;
    const original = '#!/bin/sh\n:     "$0.ran"\nexit 0\n';
    const replacement = '#!/bin/sh\ntouch "$0.ran"\nexit 0\n';
    try {
      expect(Buffer.byteLength(original)).toBe(Buffer.byteLength(replacement));
      writeFileSync(executablePath, original, { mode: 0o755 });
      chmodSync(executablePath, 0o755);
      const fixedTime = new Date(1_700_000_000_000);
      utimesSync(executablePath, fixedTime, fixedTime);
      const trusted = await resolveCliExecutable(executablePath, projectDir);
      const before = statSync(executablePath);

      writeFileSync(executablePath, replacement, { mode: 0o755 });
      chmodSync(executablePath, 0o755);
      utimesSync(executablePath, fixedTime, fixedTime);
      const after = statSync(executablePath);

      expect(after.ino).toBe(before.ino);
      expect(after.size).toBe(before.size);
      expect(after.mtimeMs).toBe(before.mtimeMs);
      await expect(
        revalidateCliStartGates({
          projectDir,
          gates: cliStartGatesFromArray([{ tool: 'codex', executable: trusted }]),
          resolveExecutable: (_command, currentProjectDir, trust) =>
            resolveCliExecutable(executablePath, currentProjectDir, trust),
        }),
      ).rejects.toMatchObject({ kind: 'cli-executable-identity-drift' });
      expect(existsSync(markerPath)).toBe(false);
    } finally {
      cleanupTempDir(projectDir);
      cleanupTempDir(executableDir);
    }
  });
});

describe('legacy readiness compatibility', () => {
  it('keeps legacy readiness conversion available without using it for fresh admission', () => {
    const readiness = deriveCliReadiness({
      tool: 'codex',
      enabled: true,
      installation: 'installed',
      executable: legacyExecutable,
      trust: 'trusted',
      installedVersion: '1.0.0',
      testedVersion: '1.0.0',
      compatibility: 'compatible',
      auth: 'not-required',
      probedAt: 1,
    });

    expect(cliStartGateFromReadiness('codex', readiness)).toEqual({
      tool: 'codex',
      executable: legacyExecutable,
    });
  });
});
