import { describe, expect, it } from 'vitest';
import { classifyCliAdmittedVersion } from './cli-version.js';

describe('CLI version classification', () => {
  it('calver newer than minimum is compatible', () => {
    expect(
      classifyCliAdmittedVersion({
        installedVersion: '2026.09.01',
        minimumAdmittedVersion: '2026.08.25',
        versionScheme: 'calver',
      }),
    ).toBe('compatible');
  });

  it('calver older than minimum is incompatible', () => {
    expect(
      classifyCliAdmittedVersion({
        installedVersion: '2026.08.24',
        minimumAdmittedVersion: '2026.08.25',
        versionScheme: 'calver',
      }),
    ).toBe('incompatible');
  });

  it('calver with build suffix parses', () => {
    expect(
      classifyCliAdmittedVersion({
        installedVersion: '2026.08.25-3e8eec8',
        minimumAdmittedVersion: '2026.08.25',
        versionScheme: 'calver',
      }),
    ).toBe('compatible');
  });
});
