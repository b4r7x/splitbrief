import { describe, expect, it } from 'vitest';
import {
  nativeCliCatalogToDetectedModels,
  parseAiderNativeModelCatalog,
  parseCodexNativeModelCatalog,
  parseKiloNativeModelCatalog,
  parseOpenCodeNativeModelCatalog,
} from './cli-model-catalog.js';

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
    expect(parseKiloNativeModelCatalog('anthropic/claude-sonnet-4-6')).toBeNull();
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
});
