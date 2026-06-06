import { describe, expect, it, vi } from 'vitest';
import { execSync } from 'node:child_process';
import { runInvariantGates, type Gate } from './check-invariants.js';

describe('check-invariants', () => {
  it('fails closed when a gate command fails', () => {
    const gate: Gate = {
      id: 'broken',
      description: 'Broken gate',
      command: 'missing-tool',
      expected: 0,
    };
    const log = vi.fn();

    const failed = runInvariantGates(
      [gate],
      () => {
        throw new Error('missing-tool');
      },
      log,
    );

    expect(failed).toBe(1);
    expect(log).toHaveBeenCalledWith('  ✗ [broken] Broken gate: command failed (expected 0) FAIL');
  });

  it('fails closed when a pipeline hides a broken command behind wc', () => {
    const gate: Gate = {
      id: 'pipeline',
      description: 'Broken pipeline',
      command: '__diptych_missing_command__ | wc -l',
      expected: 0,
    };
    const log = vi.fn();

    expect(
      execSync('bash -c "__diptych_missing_command__ | wc -l"', {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim(),
    ).toBe('0');
    expect(runInvariantGates([gate], undefined, log)).toBe(1);
    expect(log).toHaveBeenCalledWith(
      '  ✗ [pipeline] Broken pipeline: command failed (expected 0) FAIL',
    );
  });

  it('fails closed when a silent pipeline stage exits nonzero before wc', () => {
    const gate: Gate = {
      id: 'silent-pipeline',
      description: 'Silent broken pipeline',
      command: 'false | wc -l',
      expected: 0,
    };
    const log = vi.fn();

    expect(
      execSync('bash -c "false | wc -l"', {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim(),
    ).toBe('0');
    expect(runInvariantGates([gate], undefined, log)).toBe(1);
    expect(log).toHaveBeenCalledWith(
      '  ✗ [silent-pipeline] Silent broken pipeline: command failed (expected 0) FAIL',
    );
  });

  it('fails closed when gate output is not numeric', () => {
    const gate: Gate = {
      id: 'nonnumeric',
      description: 'Nonnumeric gate',
      command: 'printf not-a-number',
      expected: 0,
    };
    const log = vi.fn();

    expect(runInvariantGates([gate], undefined, log)).toBe(1);
    expect(log).toHaveBeenCalledWith(
      '  ✗ [nonnumeric] Nonnumeric gate: invalid output "not-a-number" (expected 0) FAIL',
    );
  });
});
