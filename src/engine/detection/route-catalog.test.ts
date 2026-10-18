import { describe, expect, it } from 'vitest';
import type { DetectionCacheSnapshot, RememberedCliCatalog } from './cache.js';
import { savedRouteCatalog } from './route-catalog.js';

function snapshot(cliCatalogs: readonly RememberedCliCatalog[]): DetectionCacheSnapshot {
  return {
    contextKey: 'route-catalog-test',
    fetchedAt: 1,
    validatedAt: 1,
    generation: 1,
    requestId: 1,
    providers: [],
    cliTools: [],
    cliCatalogs,
  };
}

describe('savedRouteCatalog', () => {
  it('keeps an OpenCode list whose read named the project for every route', () => {
    const named: RememberedCliCatalog = {
      tool: 'opencode',
      models: [{ id: 'lmstudio/qwen3' }],
      namesProject: true,
      probedAt: 1,
    };

    expect(savedRouteCatalog(snapshot([named]), 'opencode', 'lmstudio/qwen3')).toBe(named);
    expect(savedRouteCatalog(snapshot([named]), 'opencode', 'ollama/llama3')).toBe(named);
  });

  it('keeps an OpenCode list that did not name the project only for a route it serves', () => {
    const unnamed: RememberedCliCatalog = {
      tool: 'opencode',
      models: [{ id: 'ollama/llama3' }, { id: 'lmstudio/qwen3' }],
      missingOnce: ['lmstudio/qwen3'],
      probedAt: 1,
    };
    const saved = snapshot([unnamed]);

    expect(savedRouteCatalog(saved, 'opencode', 'ollama/gemma3')).toBe(unnamed);
    expect(savedRouteCatalog(saved, 'opencode', 'ollama-cloud/glm-5')).toBeUndefined();
    expect(savedRouteCatalog(saved, 'opencode', 'lmstudio/qwen3')).toBeUndefined();
    expect(savedRouteCatalog(saved, 'opencode', 'auto')).toBeUndefined();
    expect(savedRouteCatalog(saved, 'opencode', undefined)).toBeUndefined();
  });

  it('keeps the list of a tool whose listing takes no project', () => {
    const codex: RememberedCliCatalog = { tool: 'codex', models: [{ id: 'gpt-5' }], probedAt: 1 };

    expect(savedRouteCatalog(snapshot([codex]), 'codex', undefined)).toBe(codex);
  });

  it('reads no list from a project with no saved snapshot', () => {
    expect(savedRouteCatalog(null, 'opencode', 'ollama/llama3')).toBeUndefined();
  });
});
