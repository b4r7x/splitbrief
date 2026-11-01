import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const CELL_FILE = 'testing/integration/orchestrator/parked-cold-process.test.ts';
const ENTRIES = [0, 1, 2];

describe('parked cold process matrix', () => {
  it.each(['initial', 'local', 'consult'])(
    'keeps the stage over three cold entries of the %s route',
    (route) => {
      const proofDir = mkdtempSync(join(tmpdir(), 'splitbrief-parked-cold-'));
      try {
        for (const entry of ENTRIES) {
          const output = execFileSync(
            process.execPath,
            [
              'node_modules/vitest/vitest.mjs',
              'run',
              '--project',
              'integration',
              '--maxWorkers=1',
              CELL_FILE,
            ],
            {
              cwd: REPO_ROOT,
              env: {
                ...process.env,
                F2B_PROOF_DIR: proofDir,
                F2B_PROOF_ENTRY: String(entry),
                F2B_PROOF_ROUTE: route,
                NO_COLOR: '1',
              },
              encoding: 'utf8',
              stdio: 'pipe',
            },
          );
          // A skipped cell also exits 0, so the run must count the cell as passed.
          expect(output).toMatch(/Tests\s+2 passed \(2\)/);
        }
      } finally {
        rmSync(proofDir, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
