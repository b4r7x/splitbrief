import type { CliReadinessFacts } from '../../../src/core/schemas/readiness.js';

const executable = {
  path: '/opt/splitbrief/bin/codex',
  fingerprint: { dev: 1, ino: 2, size: 3, mtimeMs: 4 },
};

export function readyFacts(overrides: Partial<CliReadinessFacts> = {}): CliReadinessFacts {
  return {
    tool: 'codex',
    enabled: true,
    installation: 'installed',
    executable,
    trust: 'trusted',
    installedVersion: '0.40.0',
    testedVersion: '0.40.0',
    compatibility: 'compatible',
    auth: 'authenticated',
    probedAt: 1_786_000_000_000,
    ...overrides,
  };
}
