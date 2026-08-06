import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertSupportedNodeVersion } from './node-guard.js';
import { isCliError } from './errors.js';
import { readPackageJson } from '../core/project-meta.js';
import { isRecord } from '../utils/type-guards.js';

const repoRoot = join(import.meta.dirname, '..', '..');

function declaredNodeMajor(): number {
  const engines = readPackageJson(repoRoot)?.['engines'];
  const node = isRecord(engines) ? engines['node'] : undefined;
  expect(typeof node).toBe('string');
  const major = Number.parseInt(String(node).replace(/^[^\d]*/, ''), 10);
  expect(Number.isNaN(major)).toBe(false);
  return major;
}

describe('assertSupportedNodeVersion', () => {
  it('refuses a Node major below the range package.json declares', () => {
    const major = declaredNodeMajor();

    let captured: unknown;
    try {
      assertSupportedNodeVersion(`${major - 1}.99.9`);
      throw new Error('expected assertSupportedNodeVersion to throw');
    } catch (err) {
      captured = err;
    }

    expect(isCliError(captured)).toBe(true);
    expect((captured as { exitCode?: number }).exitCode).toBe(1);
    // The user must be able to read both numbers off the message: what is
    // required and what they are actually running.
    expect((captured as Error).message).toContain(String(major));
    expect((captured as Error).message).toContain(`${major - 1}.99.9`);
  });

  it('admits the declared minimum major and anything newer', () => {
    const major = declaredNodeMajor();

    expect(() => assertSupportedNodeVersion(`${major}.0.0`)).not.toThrow();
    expect(() => assertSupportedNodeVersion(`${major + 3}.1.2`)).not.toThrow();
  });

  it('admits the Node running this test suite', () => {
    expect(() => assertSupportedNodeVersion()).not.toThrow();
  });

  it('admits a runtime whose reported version has no leading major', () => {
    expect(() => assertSupportedNodeVersion('unknown')).not.toThrow();
  });
});
