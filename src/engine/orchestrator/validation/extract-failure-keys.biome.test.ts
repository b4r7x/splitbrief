import { describe, expect, it } from 'vitest';
import { failureKeys } from './extract-failure-keys.js';

describe('failureKeys — Biome', () => {
  it('drops the trailing heavy-dash rule from Biome lint, format and deserialize lines', () => {
    const stdout = [
      'src/a.ts:3:7 lint/suspicious/noExplicitAny  FIXABLE ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      'src/a.ts format ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      'biome.json:39:13 deserialize  DEPRECATED  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    ].join('\n');
    const run = {
      capture: { stdout, stderr: '', complete: true },
      exitCode: 1,
    };
    const first = failureKeys(run, '/repo');
    const second = failureKeys(run, '/repo');

    expect(first.keys.length).toBeGreaterThan(0);
    expect(first.keys).toEqual([
      'src/a.ts:3:7 lint/suspicious/noExplicitAny  FIXABLE',
      'biome.json:39:13 deserialize  DEPRECATED',
    ]);
    for (const key of first.keys) {
      expect(key).not.toContain('━');
    }
    expect(second.keys).toEqual(first.keys);
  });
});
