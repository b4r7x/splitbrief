import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findRecoveryProducerViolations } from './recovery-producers.js';

describe('findRecoveryProducerViolations', () => {
  let root: string;

  const write = (relPath: string, source: string): void => {
    const fullPath = join(root, relPath);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, source);
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'recovery-producers-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('names a live cause that no engine source raises', () => {
    write('src/engine/a.ts', "createRecoveryIssue({ reason: 'apply-conflict' });\n");
    expect(
      findRecoveryProducerViolations(root, {
        live: ['apply-conflict', 'apply-partial'],
        retired: [],
      }),
    ).toEqual(['apply-partial: a live recovery cause with no producer under src/engine']);
  });

  it('ignores tests: a cause only a test names has no producer', () => {
    write('src/engine/a.test.ts', "const reason = 'apply-partial';\n");
    expect(
      findRecoveryProducerViolations(root, { live: ['apply-partial'], retired: [] }),
    ).toHaveLength(1);
  });

  it('names a retired cause that engine source still raises', () => {
    write('src/engine/a.ts', "createRecoveryIssue({ reason: 'scope-violation' });\n");
    expect(
      findRecoveryProducerViolations(root, { live: [], retired: ['scope-violation'] }),
    ).toEqual(['scope-violation: a retired recovery cause still named under src/engine']);
  });

  it('passes on the repository itself', () => {
    expect(findRecoveryProducerViolations()).toEqual([]);
  });
});
