import { describe, expect, it } from 'vitest';
import { classifyCliAdmittedVersion, classifyCliCompilerVersion } from './cli-version.js';

describe('CLI version classification', () => {
  it.each([
    ['1.18.15', 'exact'],
    ['1.18.14', 'older'],
    ['1.18.16', 'newer'],
    ['1.19.0', 'newer'],
    ['1.18.15-beta.1', 'mismatch'],
    ['latest', 'mismatch'],
    ['', 'mismatch'],
    ['0.40', 'mismatch'],
  ] as const)(
    'classifies compiler version %s against the exact admitted version',
    (installedVersion, expected) => {
      expect(
        classifyCliCompilerVersion({
          installedVersion,
          exactAdmittedVersion: '1.18.15',
        }),
      ).toBe(expected);
    },
  );

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
