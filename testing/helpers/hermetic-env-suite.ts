import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CLI_TOOL_CATALOG } from '../../src/core/runners/cli-tool-catalog.js';
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

    it('keeps PTY shims first, blocks host CLIs, and preserves the trusted Node path', () => {
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
        const [first, blockers, ...runtimePaths] = env.PATH?.split(delimiter) ?? [];
        expect(first).toBe(shim);
        expect(runtimePaths).toEqual([...new Set([dirname(process.execPath), '/usr/bin', '/bin'])]);
        if (blockers === undefined) throw new Error('PTY CLI blocker directory is missing');
        expect(readdirSync(blockers).sort()).toEqual(
          [
            ...new Set(Object.values(CLI_TOOL_CATALOG).flatMap((tool) => tool.executableAliases)),
          ].sort(),
        );
        expect(env.HOME).toBe(root);
        expect(env.TMPDIR).toBeDefined();
        expect(safeChildEnvironment(root).PATH?.split(delimiter)).toEqual([
          blockers,
          ...runtimePaths,
        ]);
      } finally {
        vi.unstubAllEnvs();
        cleanupTempDir(root);
      }
    });
  });
}
