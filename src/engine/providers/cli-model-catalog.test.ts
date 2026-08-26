import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  nativeCliCatalogToDetectedModels,
  parseAiderNativeModelCatalog,
  parseCodexNativeModelCatalog,
  parseKiloNativeModelCatalog,
  parseOpenCodeNativeModelCatalog,
} from './cli-model-catalog.js';
import { DEFAULT_UNKNOWN_CONTEXT_LENGTH } from '../../core/tokens/context-length.js';

describe('native CLI model catalogs', () => {
  it('preserves native Codex catalog facts while leaving version admission to canonical detection', () => {
    const catalog = parseCodexNativeModelCatalog(
      JSON.stringify({
        models: [
          {
            id: 'gpt-5.6-sol',
            display_name: 'GPT-5.6 Sol',
            is_default: true,
            hidden: false,
            supported_reasoning_efforts: [
              { effort: 'low' },
              { reasoning_effort: 'medium' },
              'high',
              'xhigh',
            ],
          },
          {
            slug: 'gpt-5.6-auto-review',
            name: 'GPT-5.6 Auto Review',
            isDefault: false,
            is_hidden: true,
            reasoning_efforts: [],
          },
        ],
      }),
    );
    if (catalog === null) throw new Error('Expected admitted Codex fixture to parse');

    expect(catalog).toEqual({
      tool: 'codex',
      models: [
        {
          selectionId: 'gpt-5.6-sol',
          displayName: 'GPT-5.6 Sol',
          nativeOrder: 0,
          nativeDefault: true,
          nativeHidden: false,
          nativeReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
        },
        {
          selectionId: 'gpt-5.6-auto-review',
          displayName: 'GPT-5.6 Auto Review',
          nativeOrder: 1,
          nativeDefault: false,
          nativeHidden: true,
          nativeReasoningEfforts: [],
        },
      ],
    });
    expect(nativeCliCatalogToDetectedModels(catalog)).toEqual([
      {
        id: 'gpt-5.6-sol',
        displayName: 'GPT-5.6 Sol',
        nativeOrder: 0,
        nativeDefault: true,
        nativeHidden: false,
        nativeReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
        supportsReasoning: true,
      },
      {
        id: 'gpt-5.6-auto-review',
        displayName: 'GPT-5.6 Auto Review',
        nativeOrder: 1,
        nativeDefault: false,
        nativeHidden: true,
        nativeReasoningEfforts: [],
        supportsReasoning: false,
      },
    ]);
  });

  it('fails closed when the Codex fixture drifts or aliases contradict one another', () => {
    expect(parseCodexNativeModelCatalog('Usage: codex debug models [OPTIONS]')).toBeNull();
    expect(
      parseCodexNativeModelCatalog(
        JSON.stringify({
          models: [{ id: 'gpt-5.6-sol', slug: 'different-selection-id' }],
        }),
      ),
    ).toBeNull();
  });

  it('retains exact provider-qualified OpenCode and Kilo selections without accepting generic text', () => {
    expect(
      parseOpenCodeNativeModelCatalog(
        '\u001B[2mModels\u001B[0m\nanthropic/claude-sonnet-4-6\ncustom/provider/model@2026-08-01',
      ),
    ).toEqual({
      tool: 'opencode',
      models: [
        { selectionId: 'anthropic/claude-sonnet-4-6', nativeOrder: 0 },
        { selectionId: 'custom/provider/model@2026-08-01', nativeOrder: 1 },
      ],
    });
    expect(parseOpenCodeNativeModelCatalog('model one')).toBeNull();

    expect(
      parseKiloNativeModelCatalog('kilo/anthropic/claude-sonnet-4-6\nkilo/custom/model'),
    ).toEqual({
      tool: 'kilo-code',
      models: [
        { selectionId: 'kilo/anthropic/claude-sonnet-4-6', nativeOrder: 0 },
        { selectionId: 'kilo/custom/model', nativeOrder: 1 },
      ],
    });
    expect(parseKiloNativeModelCatalog('anthropic/claude-sonnet-4-6')).toEqual({
      tool: 'kilo-code',
      models: [{ selectionId: 'anthropic/claude-sonnet-4-6', nativeOrder: 0 }],
    });
  });

  it('keeps every provider-qualified row of a real kilo listing, not only the kilo-routed ones', () => {
    const stdout = readFileSync(
      join(import.meta.dirname, '../../../testing/fixtures/kilo-models-7.0.49.txt'),
      'utf-8',
    );

    const catalog = parseKiloNativeModelCatalog(stdout);
    if (catalog === null) throw new Error('Expected the real kilo listing to parse');

    expect(catalog.models).toHaveLength(126);
    expect(catalog.models.map((model) => model.selectionId)).toContain(
      'alibaba-coding-plan/glm-4.7',
    );
    expect(new Set(catalog.models.map((model) => model.selectionId.split('/')[0]))).toEqual(
      new Set([
        'kilo',
        'alibaba-coding-plan',
        'github-copilot',
        'kimi-for-coding',
        'ollama-cloud',
        'openai',
      ]),
    );
  });

  it('parses only canonical dashed Aider rows and ignores catalog headings', () => {
    expect(
      parseAiderNativeModelCatalog(
        [
          '=== Available Models ===',
          '- Available Models',
          '- GPT-4o (openai/gpt-4o)',
          '- anthropic/claude-sonnet-4-6',
          '---',
        ].join('\n'),
      ),
    ).toEqual({
      tool: 'aider',
      models: [
        { selectionId: 'openai/gpt-4o', nativeOrder: 0 },
        { selectionId: 'anthropic/claude-sonnet-4-6', nativeOrder: 1 },
      ],
    });
    expect(parseAiderNativeModelCatalog('openai/gpt-4o')).toBeNull();
    expect(parseAiderNativeModelCatalog('- GPT-4o')).toBeNull();
  });

  it("a cataloged codex model's contextLength equals its context_window; routing does not use the 32768 fallback for it", () => {
    const contextWindow = 1_050_000;
    const catalog = parseCodexNativeModelCatalog(
      JSON.stringify({
        models: [{ id: 'gpt-5.4', display_name: 'GPT-5.4', context_window: contextWindow }],
      }),
    );
    if (catalog === null) throw new Error('Expected codex catalog fixture to parse');

    expect(catalog.models[0]?.contextWindow).toBe(contextWindow);

    const [detected] = nativeCliCatalogToDetectedModels(catalog);
    if (detected === undefined) throw new Error('Expected one detected model');

    expect(detected.contextLength).toBe(contextWindow);

    const routedContextLength = detected.contextLength ?? DEFAULT_UNKNOWN_CONTEXT_LENGTH;
    expect(routedContextLength).toBe(contextWindow);
    expect(routedContextLength).not.toBe(DEFAULT_UNKNOWN_CONTEXT_LENGTH);
  });
});
