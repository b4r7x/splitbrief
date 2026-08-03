import { describe, expect, it } from 'vitest';
import {
  findGenericCliCatalogRuntime,
  findScopedCliCatalogRuntime,
  reconcileScopedCliCatalogAttempts,
  scopedCliCatalogConnection,
} from './cli-catalog-outcomes.js';

const planner = { role: 'planner' as const, tool: 'codex' as const, contextKey: 'planner-a' };
const implementer = {
  role: 'implementer' as const,
  tool: 'codex' as const,
  contextKey: 'implementer-a',
};

describe('scoped CLI catalog outcomes', () => {
  it('retains stale models only for the exact failed role/tool/context connection', () => {
    const first = reconcileScopedCliCatalogAttempts({
      previous: [],
      observedAt: 10,
      attempts: [
        { connection: planner, outcome: { kind: 'success', value: [{ id: 'planner-model' }] } },
        {
          connection: implementer,
          outcome: { kind: 'success', value: [{ id: 'implementer-model' }] },
        },
      ],
    });
    const second = reconcileScopedCliCatalogAttempts({
      previous: first,
      observedAt: 20,
      attempts: [
        { connection: planner, outcome: { kind: 'offline' } },
        {
          connection: implementer,
          outcome: { kind: 'success', value: [{ id: 'implementer-new-model' }] },
        },
      ],
    });

    expect(findScopedCliCatalogRuntime(second, planner)).toMatchObject({
      state: 'stale',
      models: [{ id: 'planner-model' }],
      failure: 'offline',
    });
    expect(findScopedCliCatalogRuntime(second, implementer)).toMatchObject({
      state: 'fresh',
      models: [{ id: 'implementer-new-model' }],
    });
  });

  it('treats a valid empty catalog as authoritative for only its own connection', () => {
    const first = reconcileScopedCliCatalogAttempts({
      previous: [],
      observedAt: 10,
      attempts: [
        { connection: planner, outcome: { kind: 'success', value: [{ id: 'planner-model' }] } },
        {
          connection: implementer,
          outcome: { kind: 'success', value: [{ id: 'implementer-model' }] },
        },
      ],
    });
    const second = reconcileScopedCliCatalogAttempts({
      previous: first,
      observedAt: 20,
      attempts: [{ connection: planner, outcome: { kind: 'success', value: [] } }],
    });

    expect(findScopedCliCatalogRuntime(second, planner)).toMatchObject({
      state: 'fresh',
      models: [],
    });
    expect(findScopedCliCatalogRuntime(second, implementer)).toMatchObject({
      state: 'fresh',
      models: [{ id: 'implementer-model' }],
    });
  });

  it('does not synthesize an empty catalog for a first failure', () => {
    const runtimes = reconcileScopedCliCatalogAttempts({
      previous: [],
      observedAt: 10,
      attempts: [{ connection: planner, outcome: { kind: 'malformed' } }],
    });

    expect(findScopedCliCatalogRuntime(runtimes, planner)).toMatchObject({
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
        { connection: planner, outcome: { kind: 'success', value: [{ id: 'old-executable' }] } },
      ],
    });
    const replacement = { ...planner, contextKey: 'planner-replaced-executable' };
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

  it('rejects generic and role lookup when two selected channel contexts are ambiguous', () => {
    const alternatePlanner = { ...planner, contextKey: 'planner-b' };
    const runtimes = reconcileScopedCliCatalogAttempts({
      previous: [],
      observedAt: 10,
      attempts: [
        { connection: planner, outcome: { kind: 'success', value: [{ id: 'channel-a' }] } },
        {
          connection: alternatePlanner,
          outcome: { kind: 'success', value: [{ id: 'channel-b' }] },
        },
      ],
    });

    expect(findScopedCliCatalogRuntime(runtimes, planner)).toBeNull();
    expect(findGenericCliCatalogRuntime(runtimes, 'codex')).toBeNull();
  });

  it('binds an opaque public context token to the full digest-bound executable receipt', () => {
    const first = scopedCliCatalogConnection({
      role: 'planner',
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
      role: 'planner',
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
