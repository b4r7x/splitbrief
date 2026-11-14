import { describe, expect, it } from 'vitest';
import { NATIVE_CLI_CATALOG_TOOL_IDS } from '../../core/runners/cli-tool/catalog.js';
import {
  cloneScopedCliCatalogAttempt,
  scopedCliCatalogConnection,
} from './cli-catalog-outcomes.js';

const opencode = { tool: 'opencode' as const, contextKey: 'opencode-a' };
const executable = {
  path: '/trusted/codex',
  fingerprint: { dev: 1, ino: 2, size: 3, mtimeMs: 4 },
  executableIdentity: {
    canonicalPath: '/trusted/codex',
    realPath: '/trusted/codex',
    platformFileId: '1:2',
    fingerprint: `1:2:3:4:sha256:${'a'.repeat(64)}`,
    resolvedAt: 1,
  },
};

describe('scoped CLI catalog outcomes', () => {
  it('binds an opaque public context token to the full digest-bound executable receipt', () => {
    const first = scopedCliCatalogConnection({ tool: 'codex', executable });
    const replacement = scopedCliCatalogConnection({
      tool: 'codex',
      executable: {
        path: '/trusted/codex',
        fingerprint: { dev: 1, ino: 2, size: 3, mtimeMs: 4 },
        executableIdentity: {
          canonicalPath: '/trusted/codex',
          realPath: '/trusted/codex',
          platformFileId: '1:2',
          fingerprint: `1:2:3:4:sha256:${'b'.repeat(64)}`,
          resolvedAt: 1,
        },
      },
    });

    expect(first.contextKey).not.toBe(replacement.contextKey);
    expect(JSON.stringify([first, replacement])).not.toContain('/trusted/codex');
    expect(JSON.stringify([first, replacement])).not.toContain('a'.repeat(64));
    expect(JSON.stringify([first, replacement])).not.toContain('b'.repeat(64));
  });

  it.each(NATIVE_CLI_CATALOG_TOOL_IDS)(
    'keeps the %s identity stable while separating executables',
    (tool) => {
      const first = scopedCliCatalogConnection({ tool, executable });
      const repeated = scopedCliCatalogConnection({
        tool,
        executable: {
          ...executable,
          executableIdentity: { ...executable.executableIdentity, resolvedAt: 2 },
        },
      });
      expect(repeated).toEqual(first);
      expect(
        scopedCliCatalogConnection({
          tool,
          executable: {
            ...executable,
            executableIdentity: { ...executable.executableIdentity, platformFileId: '1:3' },
          },
        }),
      ).not.toEqual(first);
    },
  );

  it('keeps the connection key of each tool on its catalog channel', () => {
    expect(
      NATIVE_CLI_CATALOG_TOOL_IDS.map((tool) => scopedCliCatalogConnection({ tool }).contextKey),
    ).toEqual([
      'cli-catalog-v1|codex|session|cli-executable-unresolved',
      'cli-catalog-v1|opencode|provider-dependent|cli-executable-unresolved',
      'cli-catalog-v1|copilot|session|cli-executable-unresolved',
      'cli-catalog-v1|kilo-code|provider-dependent|cli-executable-unresolved',
      'cli-catalog-v1|cursor|session|cli-executable-unresolved',
      'cli-catalog-v1|command-code|session|cli-executable-unresolved',
      'cli-catalog-v1|antigravity|session|cli-executable-unresolved',
    ]);
  });

  it('carries a failed listing command and its cause through a clone', () => {
    const cause =
      'Server at http://127.0.0.1:49374 did not provide a compatible V2 health response';
    const attempt = { connection: opencode, outcome: { kind: 'command-failed', cause } } as const;

    expect(cloneScopedCliCatalogAttempt(attempt)).toEqual(attempt);
  });
});
