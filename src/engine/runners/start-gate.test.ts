import { describe, expect, it } from 'vitest';
import type { CliToolDetection } from '../../core/discovery/detection.js';
import {
  cliStartGateFromDetection,
  cliStartGateFromReadiness,
  cliStartGatesFromReadiness,
} from './start-gate.js';
import { deriveCliReadiness } from '../../core/schemas/readiness.js';

function detection(overrides: Partial<CliToolDetection> = {}): CliToolDetection {
  return {
    tool: 'codex',
    executable: {
      path: '/usr/local/bin/codex',
      fingerprint: { dev: 1, ino: 2, size: 3, mtimeMs: 4 },
    },
    trust: 'trusted',
    installedVersion: '1.0.0',
    testedVersion: '1.0.0',
    compatibility: 'compatible',
    auth: 'not-required',
    diagnostic: { state: 'ready', remediation: null },
    probedAt: 1,
    ...overrides,
  };
}

describe('CLI start gate', () => {
  it('projects only a canonical ready detection into a typed gate', () => {
    expect(cliStartGateFromDetection('codex', detection())).toEqual({
      tool: 'codex',
      executable: {
        path: '/usr/local/bin/codex',
        fingerprint: { dev: 1, ino: 2, size: 3, mtimeMs: 4 },
      },
    });
  });

  it.each([
    ['missing', undefined],
    [
      'untrusted',
      detection({
        trust: 'untrusted',
        diagnostic: { state: 'untrusted', remediation: 'trust it' },
      }),
    ],
    ['not-ready', detection({ diagnostic: { state: 'unverified', remediation: 'verify it' } })],
    [
      'missing identity',
      detection({
        executable: null,
        diagnostic: { state: 'unavailable', remediation: 'install it' },
      }),
    ],
  ] as const)('fails closed for %s readiness', (_label, candidate) => {
    expect(() => cliStartGateFromDetection('codex', candidate)).toThrowError(
      expect.objectContaining({ kind: 'cli-executable-untrusted' }),
    );
  });

  it('rejects a gate requested for a different tool', () => {
    expect(() => cliStartGateFromDetection('claude-code', detection())).toThrowError(
      expect.objectContaining({ kind: 'cli-executable-untrusted' }),
    );
  });

  it('projects only ready canonical readiness facts into execution gates', () => {
    const ready = deriveCliReadiness({
      tool: 'codex',
      enabled: true,
      installation: 'installed',
      executable: detection().executable,
      trust: 'trusted',
      installedVersion: '1.0.0',
      testedVersion: '1.0.0',
      compatibility: 'compatible',
      auth: 'not-required',
      probedAt: 1,
    });
    const blocked = deriveCliReadiness({
      tool: 'claude-code',
      enabled: true,
      installation: 'installed',
      executable: detection().executable,
      trust: 'untrusted',
      installedVersion: null,
      testedVersion: '1.0.0',
      compatibility: 'not-checked',
      auth: 'not-checked',
      probedAt: 1,
    });

    expect(cliStartGateFromReadiness('codex', ready).executable.path).toBe('/usr/local/bin/codex');
    expect(cliStartGatesFromReadiness([ready, blocked]).has('codex')).toBe(true);
    expect(cliStartGatesFromReadiness([ready, blocked]).has('claude-code')).toBe(false);
    expect(() => cliStartGateFromReadiness('claude-code', blocked)).toThrowError(
      expect.objectContaining({ kind: 'cli-executable-untrusted' }),
    );
  });
});
