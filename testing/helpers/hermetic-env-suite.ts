import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { safeChildEnvironment } from '../integration/cli/pty/run.js';
import { isTestCredentialEnvironmentName } from './hermetic-env.js';
import { cleanupTempDir } from './temp-dir.js';

// Prove the setup with OPENAI_API_KEY=sk-fake ANTHROPIC_API_KEY=sk-fake in the
// parent environment. Run the hermetic-env suites in unit, integration and e2e.
export function describeHermeticEnvironment(): void {
  describe('hermetic test environment', () => {
    it('starts without inherited provider or tool credentials', () => {
      expect(Object.keys(process.env).filter(isTestCredentialEnvironmentName)).toEqual([]);
    });

    it('keeps PTY shims first and puts only node, npm and npx before the system directories', () => {
      const root = mkdtempSync(join(tmpdir(), 'hermetic-pty-path-'));
      const shim = join(root, 'bin');
      const host = join(root, 'host-bin');
      vi.stubEnv(
        'PATH',
        [host, '/Users/owner/.local/bin', '/opt/homebrew/bin', shim, '/usr/bin', '.'].join(
          delimiter,
        ),
      );
      try {
        const env = safeChildEnvironment(root, [shim]);
        const [first, runtime, ...systemPaths] = env.PATH?.split(delimiter) ?? [];
        expect(first).toBe(shim);
        expect(systemPaths).toEqual(['/usr/bin', '/bin']);
        if (runtime === undefined) throw new Error('PTY node runtime directory is missing');
        expect(readdirSync(runtime).sort()).toEqual(['node', 'npm', 'npx']);
        expect(env.HOME).toBe(root);
        expect(env.TMPDIR).toBeDefined();
        expect(safeChildEnvironment(root).PATH?.split(delimiter)).toEqual([
          runtime,
          ...systemPaths,
        ]);
      } finally {
        vi.unstubAllEnvs();
        cleanupTempDir(root);
      }
    });
  });
}
