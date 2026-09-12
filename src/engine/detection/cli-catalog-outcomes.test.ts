import { describe, expect, it } from 'vitest';
import {
  findCliCatalogRuntime,
  reconcileScopedCliCatalogAttempts,
  scopedCliCatalogConnection,
} from './cli-catalog-outcomes.js';

const codex = { tool: 'codex' as const, contextKey: 'codex-a' };
const opencode = { tool: 'opencode' as const, contextKey: 'opencode-a' };

describe('scoped CLI catalog outcomes', () => {
  it('retains stale models only for the exact failed tool/context connection', () => {
    const first = reconcileScopedCliCatalogAttempts({
      previous: [],
      observedAt: 10,
      attempts: [
        { connection: codex, outcome: { kind: 'success', value: [{ id: 'codex-model' }] } },
        {
          connection: opencode,
          outcome: { kind: 'success', value: [{ id: 'opencode-model' }] },
        },
      ],
    });
    const second = reconcileScopedCliCatalogAttempts({
      previous: first,
      observedAt: 20,
      attempts: [
        { connection: codex, outcome: { kind: 'offline' } },
        {
          connection: opencode,
          outcome: { kind: 'success', value: [{ id: 'opencode-new-model' }] },
        },
      ],
    });

    expect(findCliCatalogRuntime(second, 'codex')).toMatchObject({
      state: 'stale',
      models: [{ id: 'codex-model' }],
      failure: 'offline',
    });
    expect(findCliCatalogRuntime(second, 'opencode')).toMatchObject({
      state: 'fresh',
      models: [{ id: 'opencode-new-model' }],
    });
  });

  it('treats a valid empty catalog as authoritative for only its own connection', () => {
    const first = reconcileScopedCliCatalogAttempts({
      previous: [],
      observedAt: 10,
      attempts: [
        { connection: codex, outcome: { kind: 'success', value: [{ id: 'codex-model' }] } },
        {
          connection: opencode,
          outcome: { kind: 'success', value: [{ id: 'opencode-model' }] },
        },
      ],
    });
    const second = reconcileScopedCliCatalogAttempts({
      previous: first,
      observedAt: 20,
      attempts: [{ connection: codex, outcome: { kind: 'success', value: [] } }],
    });

    expect(findCliCatalogRuntime(second, 'codex')).toMatchObject({
      state: 'fresh',
      models: [],
    });
    expect(findCliCatalogRuntime(second, 'opencode')).toMatchObject({
      state: 'fresh',
      models: [{ id: 'opencode-model' }],
    });
  });

  it('does not synthesize an empty catalog for a first failure', () => {
    const runtimes = reconcileScopedCliCatalogAttempts({
      previous: [],
      observedAt: 10,
      attempts: [{ connection: codex, outcome: { kind: 'malformed' } }],
    });

    expect(findCliCatalogRuntime(runtimes, 'codex')).toMatchObject({
      state: 'failed',
      models: null,
      failure: 'malformed',
    });
  });

  it('drops an obsolete executable context instead of reusing its models for a replacement', () => {
    const first = reconcileScopedCliCatalogAttempts({
      previous: [],
      observedAt: 10,
      attempts: [
        { connection: codex, outcome: { kind: 'success', value: [{ id: 'old-executable' }] } },
      ],
    });
    const replacement = { ...codex, contextKey: 'codex-replaced-executable' };
    const second = reconcileScopedCliCatalogAttempts({
      previous: first,
      observedAt: 20,
      attempts: [{ connection: replacement, outcome: { kind: 'offline' } }],
    });

    expect(second).toEqual([
      expect.objectContaining({
        connection: replacement,
        state: 'failed',
        models: null,
        failure: 'offline',
      }),
    ]);
    expect(JSON.stringify(second)).not.toContain('old-executable');
  });

  it('rejects a tool lookup when two executable contexts are ambiguous', () => {
    const alternateCodex = { ...codex, contextKey: 'codex-b' };
    const runtimes = reconcileScopedCliCatalogAttempts({
      previous: [],
      observedAt: 10,
      attempts: [
        { connection: codex, outcome: { kind: 'success', value: [{ id: 'channel-a' }] } },
        { connection: alternateCodex, outcome: { kind: 'success', value: [{ id: 'channel-b' }] } },
        { connection: opencode, outcome: { kind: 'success', value: [{ id: 'opencode-model' }] } },
      ],
    });

    expect(findCliCatalogRuntime(runtimes, 'codex')).toBeNull();
    expect(findCliCatalogRuntime(runtimes, 'opencode')).toMatchObject({
      state: 'fresh',
      models: [{ id: 'opencode-model' }],
    });
  });

  it('binds an opaque public context token to the full digest-bound executable receipt', () => {
    const first = scopedCliCatalogConnection({
      tool: 'codex',
      runnerContextKey: 'safe-config-context',
      executable: {
        path: '/trusted/codex',
        fingerprint: { dev: 1, ino: 2, size: 3, mtimeMs: 4 },
        executableIdentity: {
          canonicalPath: '/trusted/codex',
          realPath: '/trusted/codex',
          platformFileId: '1:2',
          fingerprint: `1:2:3:4:sha256:${'a'.repeat(64)}`,
          resolvedAt: 1,
        },
      },
    });
    const replacement = scopedCliCatalogConnection({
      tool: 'codex',
      runnerContextKey: 'safe-config-context',
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
});
