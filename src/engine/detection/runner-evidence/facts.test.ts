import { describe, expect, it } from 'vitest';
import type { RunnerDiscoveryContext } from '../../../core/config/accessors/runner-discovery-context.js';
import { CLI_TOOL_CATALOG } from '../../../core/runners/cli-tool/catalog.js';
import { compatibilityFromVersion, credentialFromCliAuth } from './facts.js';

const CODEX = CLI_TOOL_CATALOG.codex.compatibility;

const SESSION_CONTEXT: RunnerDiscoveryContext = {
  role: 'planner',
  kind: 'cli',
  id: 'codex',
  authChannel: 'session',
  credentialPresent: false,
  configGeneration: 'test-config-generation',
};

describe('compatibilityFromVersion', () => {
  it.each([
    ['the inclusive Codex minimum', '0.40.0', 'compatible'],
    ['an admitted Codex patch', '0.40.7', 'compatible'],
    ['a newer Codex minor than the tested release', '0.41.0', 'compatible'],
    ['a current Codex release far above the tested minimum', '0.146.0', 'compatible'],
    ['a lower Codex release', '0.39.9', 'incompatible'],
    ['an earlier pre-1.0 Codex minor', '0.1.0', 'incompatible'],
    ['a Codex prerelease', '0.40.0-rc.1', 'unknown'],
    ['a malformed Codex version', '0.40', 'unknown'],
  ] as const)("classifies %s through Codex's minimum admitted version", (_label, version, kind) => {
    expect(
      compatibilityFromVersion({
        version: { kind: 'success', value: version },
        compatibility: CODEX,
      }),
    ).toEqual({ kind, installedVersion: version, testedVersion: CODEX.testedVersion });
  });
});

describe('credentialFromCliAuth', () => {
  it.each([
    ['missing', 'absent'],
    ['invalid', 'present'],
    ['policy-denied', 'unknown'],
    ['offline', 'unknown'],
    ['timeout', 'unknown'],
    ['malformed', 'unknown'],
  ] as const)('reads the credential of the %s authentication fact', (auth, credential) => {
    expect(credentialFromCliAuth(SESSION_CONTEXT, auth)).toBe(credential);
  });
});
