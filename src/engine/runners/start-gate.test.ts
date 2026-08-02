import { describe, expect, it } from 'vitest';
import type { CliExecutableIdentity } from '../../core/discovery/detection.js';
import { cliStartGateFromReadiness, cliStartGatesFromReadiness } from './start-gate.js';
import { deriveCliReadiness, type CliReadinessFacts } from '../../core/schemas/readiness.js';

const executable: CliExecutableIdentity = {
  path: '/usr/local/bin/codex',
  fingerprint: { dev: 1, ino: 2, size: 3, mtimeMs: 4 },
};

function readiness(overrides: Partial<CliReadinessFacts> = {}) {
  return deriveCliReadiness({
    tool: 'codex',
    enabled: true,
    installation: 'installed',
    executable,
    trust: 'trusted',
    installedVersion: '1.0.0',
    testedVersion: '1.0.0',
    compatibility: 'compatible',
    auth: 'not-required',
    probedAt: 1,
    ...overrides,
  });
}

describe('CLI start gate', () => {
  it('projects only a canonical ready readiness fact into a typed gate', () => {
    expect(cliStartGateFromReadiness('codex', readiness())).toEqual({ tool: 'codex', executable });
  });

  it.each([
    ['missing', undefined],
    [
      'untrusted',
      readiness({ trust: 'untrusted', compatibility: 'not-checked', auth: 'not-checked' }),
    ],
    ['incompatible', readiness({ compatibility: 'incompatible', auth: 'not-checked' })],
    ['unauthenticated', readiness({ auth: 'unauthenticated' })],
    [
      'missing identity',
      readiness({
        installation: 'unavailable',
        executable: null,
        trust: 'not-checked',
        installedVersion: null,
        compatibility: 'not-checked',
        auth: 'not-checked',
      }),
    ],
  ] as const)('fails closed for %s readiness', (_label, candidate) => {
    expect(() => cliStartGateFromReadiness('codex', candidate)).toThrowError(
      expect.objectContaining({ kind: 'cli-executable-untrusted' }),
    );
  });

  it('rejects a gate requested for a different tool', () => {
    expect(() => cliStartGateFromReadiness('claude-code', readiness())).toThrowError(
      expect.objectContaining({ kind: 'cli-executable-untrusted' }),
    );
  });

  it('keeps only ready canonical readiness facts in the execution gate map', () => {
    const blocked = deriveCliReadiness({
      tool: 'claude-code',
      enabled: true,
      installation: 'installed',
      executable,
      trust: 'untrusted',
      installedVersion: null,
      testedVersion: '1.0.0',
      compatibility: 'not-checked',
      auth: 'not-checked',
      probedAt: 1,
    });

    expect(cliStartGateFromReadiness('codex', readiness()).executable.path).toBe(
      '/usr/local/bin/codex',
    );
    expect(cliStartGatesFromReadiness([readiness(), blocked]).has('codex')).toBe(true);
    expect(cliStartGatesFromReadiness([readiness(), blocked]).has('claude-code')).toBe(false);
    expect(() => cliStartGateFromReadiness('claude-code', blocked)).toThrowError(
      expect.objectContaining({ kind: 'cli-executable-untrusted' }),
    );
  });
});
