import { describe, expect, it } from 'vitest';
import {
  admitCliAuthChannel,
  applyCliAuthChoice,
  deriveCliAuthSelection,
} from './cli-auth-selection.js';
import {
  CLI_AUTH_ENFORCEMENT_EVIDENCE,
  CLI_TOOL_IDS,
  type CliAuthEnforcementEvidence,
} from './cli-tool-catalog.js';

const MATRIX: readonly CliAuthEnforcementEvidence[] = [
  {
    id: 'codex-darwin-0.154.0',
    tool: 'codex',
    platform: 'darwin',
    installedVersion: '0.154.0',
    channels: ['session', 'api-key'],
  },
  {
    id: 'opencode-darwin-2.0.4',
    tool: 'opencode',
    platform: 'darwin',
    installedVersion: '2.0.4',
    channels: ['session', 'api-key'],
  },
];

const codex = { tool: 'codex', platform: 'darwin', evidence: MATRIX } as const;

describe('deriveCliAuthSelection', () => {
  it('offers the proven methods for the exact installed version and platform', () => {
    expect(deriveCliAuthSelection({ ...codex, installedVersion: '0.154.0' })).toEqual({
      kind: 'enforceable',
      channels: ['session', 'api-key'],
      evidenceId: 'codex-darwin-0.154.0',
    });
  });

  it('falls back to host configuration for an unproven or unknown version or platform', () => {
    expect(deriveCliAuthSelection({ ...codex, installedVersion: '0.155.0' })).toEqual({
      kind: 'host-configured',
      reason: 'version-unproven',
    });
    expect(deriveCliAuthSelection({ ...codex, installedVersion: undefined })).toEqual({
      kind: 'host-configured',
      reason: 'version-unknown',
    });
    expect(
      deriveCliAuthSelection({ ...codex, platform: 'linux', installedVersion: '0.154.0' }),
    ).toEqual({ kind: 'host-configured', reason: 'platform-unproven' });
  });

  it('never adds a method a tool does not declare, so OpenCode and Kilo stay host-configured', () => {
    for (const tool of ['opencode', 'kilo-code']) {
      expect(
        deriveCliAuthSelection({
          tool,
          platform: 'darwin',
          installedVersion: '2.0.4',
          evidence: MATRIX,
        }),
      ).toEqual({ kind: 'host-configured', reason: 'no-evidence' });
    }
  });

  it('reports a tool outside the admitted catalog as unsupported', () => {
    expect(
      deriveCliAuthSelection({ tool: 'gemini', platform: 'darwin', installedVersion: '1.0.0' }),
    ).toEqual({ kind: 'unsupported', reason: 'not-admitted' });
  });

  it('proves nothing enforceable for any admitted CLI today', () => {
    expect(CLI_AUTH_ENFORCEMENT_EVIDENCE).toEqual([]);
    for (const tool of CLI_TOOL_IDS) {
      expect(
        deriveCliAuthSelection({ tool, platform: process.platform, installedVersion: '1.0.0' }),
      ).toEqual({ kind: 'host-configured', reason: 'no-evidence' });
    }
  });
});

describe('admitCliAuthChannel', () => {
  it('lets an omitted or provider-dependent channel run on host configuration', () => {
    expect(
      admitCliAuthChannel({ ...codex, installedVersion: undefined, authChannel: undefined }),
    ).toEqual({ kind: 'host-configured' });
    expect(
      admitCliAuthChannel({
        tool: 'opencode',
        platform: 'darwin',
        installedVersion: undefined,
        authChannel: 'provider-dependent',
      }),
    ).toEqual({ kind: 'host-configured' });
  });

  it('enforces an explicit method only with current proof', () => {
    expect(
      admitCliAuthChannel({ ...codex, installedVersion: '0.154.0', authChannel: 'api-key' }),
    ).toEqual({ kind: 'enforced', channel: 'api-key', evidenceId: 'codex-darwin-0.154.0' });
  });

  it.each([
    ['an unproven method', 'claude-code', '2.1.273', 'session'],
    ['a proven selection after version drift', 'codex', '0.155.0', 'api-key'],
  ] as const)(
    'refuses %s instead of treating it as host-configured',
    (_case, tool, version, channel) => {
      const admission = admitCliAuthChannel({
        tool,
        platform: 'darwin',
        installedVersion: version,
        authChannel: channel,
        evidence: MATRIX,
      });
      expect(admission).toMatchObject({ kind: 'refused', channel });
      expect(admission.kind === 'refused' && admission.message).toContain('Remove authChannel');
    },
  );
});

describe('applyCliAuthChoice', () => {
  it('removes the explicit field when host configuration is chosen', () => {
    const runner = { kind: 'cli', tool: 'claude-code', authChannel: 'session' } as const;
    expect(applyCliAuthChoice(runner, 'host-configured')).toEqual({
      kind: 'cli',
      tool: 'claude-code',
    });
    expect(applyCliAuthChoice(runner, 'api-key')).toEqual({ ...runner, authChannel: 'api-key' });
  });
});
