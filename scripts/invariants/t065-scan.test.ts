import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scanT065Invariants } from './t065-scan.js';

describe('scanT065Invariants', () => {
  it('reports the exact source path and line for a direct state-writer violation', () => {
    const root = mkdtempSync(join(tmpdir(), 'splitbrief-t065-'));
    try {
      const path = join(root, 'cli', 'bad.ts');
      mkdirSync(join(root, 'cli'), { recursive: true });
      writeFileSync(
        path,
        "import { saveState } from '../core/state/persistence.js';\nsaveState(ref, state);\n",
      );

      const findings = scanT065Invariants(root, 'direct-state');

      expect(findings).toHaveLength(2);
      expect(findings[0]).toEqual(
        expect.objectContaining({
          rule: 'direct-state',
          path: expect.stringContaining('cli/bad.ts'),
          line: 1,
        }),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('classifies owner hydration and rejects an unclassified loadState path', () => {
    const root = mkdtempSync(join(tmpdir(), 'splitbrief-t065-hydration-'));
    try {
      mkdirSync(join(root, 'app'), { recursive: true });
      mkdirSync(join(root, 'misc'), { recursive: true });
      writeFileSync(
        join(root, 'app', 'prepare-resume.ts'),
        "import { loadState } from '../core/state/persistence.js';\nexport const resume = () => loadState(ref);\n",
      );
      writeFileSync(
        join(root, 'misc', 'reader.ts'),
        "import { loadState } from '../core/state/persistence.js';\nexport const read = () => loadState(ref);\n",
      );

      const findings = scanT065Invariants(root, 'hydration');

      expect(findings.map((finding) => finding.path)).toEqual([
        expect.stringContaining('app/prepare-resume.ts'),
        expect.stringContaining('app/prepare-resume.ts'),
        expect.stringContaining('misc/reader.ts'),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a recovery marker that can re-enter review without the guard fields', () => {
    const root = mkdtempSync(join(tmpdir(), 'splitbrief-t065-marker-'));
    try {
      const path = join(root, 'engine', 'bad.ts');
      mkdirSync(join(root, 'engine'), { recursive: true });
      writeFileSync(
        path,
        "const marker = { briefRecovery: true, operationId: 'op-1' };\nplanner.review(prompt);\n",
      );

      const findings = scanT065Invariants(root, 'recovery-marker');

      expect(findings).toEqual([
        expect.objectContaining({ path: expect.stringContaining('engine/bad.ts'), line: 1 }),
        expect.objectContaining({ path: expect.stringContaining('engine/bad.ts'), line: 2 }),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed when the T-065 source root is missing', () => {
    expect(() => scanT065Invariants('/tmp/splitbrief-t065-does-not-exist')).toThrow(
      'T-065 source root does not exist',
    );
  });
});
