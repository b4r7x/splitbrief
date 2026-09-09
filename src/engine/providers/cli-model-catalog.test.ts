import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DetectedModelSchema } from '../../core/discovery/detection.js';
import {
  nativeCliCatalogToDetectedModels,
  parseCodexNativeModelCatalog,
  parseCommandCodeNativeModelCatalog,
  parseCopilotHelpConfigCatalog,
  parseCursorNativeModelCatalog,
  parseKiloNativeModelCatalog,
  parseOpenCodeNativeModelCatalog,
} from './cli-model-catalog.js';

// Two-model slice of `codex debug models --bundled` (codex-cli 0.153.3, captured 2026-09-08).
const CODEX_BUNDLED_SLICE = {
  models: [
    {
      slug: 'gpt-5.6-sol',
      display_name: 'GPT-5.6-Sol',
      default_reasoning_level: 'low',
      supported_reasoning_levels: [
        { effort: 'low', description: 'Fast responses with lighter reasoning' },
        { effort: 'medium', description: 'Balances speed and reasoning depth for everyday tasks' },
        { effort: 'high', description: 'Greater reasoning depth for complex problems' },
        { effort: 'xhigh', description: 'Extra high reasoning depth for complex problems' },
        { effort: 'max', description: 'Maximum reasoning depth for the hardest problems' },
        { effort: 'ultra', description: 'Maximum reasoning with automatic task delegation' },
      ],
    },
    {
      slug: 'gpt-5.5',
      display_name: 'GPT-5.5',
      default_reasoning_level: 'medium',
      supported_reasoning_levels: [
        { effort: 'low', description: 'Fast responses with lighter reasoning' },
        { effort: 'medium', description: 'Balances speed and reasoning depth for everyday tasks' },
        { effort: 'high', description: 'Greater reasoning depth for complex problems' },
        { effort: 'xhigh', description: 'Extra high reasoning depth for complex problems' },
      ],
    },
  ],
};

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

  // Captured verbatim with `opencode models openai --verbose` and
  // `opencode models opencode-go --verbose` on opencode 1.18.15.
  it('reads the per-model ladder, catalog name and context window from a verbose listing', () => {
    const stdout = readFileSync(
      join(import.meta.dirname, '../../../testing/fixtures/opencode/models-verbose.txt'),
      'utf-8',
    );

    const catalog = parseOpenCodeNativeModelCatalog(stdout);
    if (catalog === null) throw new Error('Expected the verbose OpenCode listing to parse');

    const lunaLadder = ['none', 'low', 'medium', 'high', 'xhigh', 'max'];
    expect(catalog.models).toEqual([
      {
        selectionId: 'openai/gpt-5.6-luna',
        nativeOrder: 0,
        displayName: 'GPT-5.6 Luna',
        contextWindow: 500_000,
        nativeReasoningEfforts: lunaLadder,
      },
      {
        selectionId: 'openai/gpt-5.6-luna-fast',
        nativeOrder: 1,
        displayName: 'GPT-5.6 Luna Fast',
        contextWindow: 500_000,
        nativeReasoningEfforts: lunaLadder,
      },
      {
        selectionId: 'opencode-go/gpt-5.6-luna',
        nativeOrder: 2,
        displayName: 'GPT-5.6 Luna',
        contextWindow: 1_050_000,
        nativeReasoningEfforts: lunaLadder,
      },
      {
        selectionId: 'opencode-go/minimax-m3',
        nativeOrder: 3,
        displayName: 'MiniMax-M3',
        contextWindow: 1_000_000,
        nativeReasoningEfforts: ['none', 'thinking'],
      },
      {
        selectionId: 'opencode-go/qwen3.7-max',
        nativeOrder: 4,
        displayName: 'Qwen3.7 Max',
        contextWindow: 1_000_000,
        nativeReasoningEfforts: [],
      },
    ]);

    // The two claims made about `openai/gpt-5.6-luna`: `max` is offered, `minimal` is not.
    expect(catalog.models[0]?.nativeReasoningEfforts).toContain('max');
    expect(catalog.models[0]?.nativeReasoningEfforts).not.toContain('minimal');
  });

  it('keeps bare id rows beside verbose block rows in one listing', () => {
    expect(
      parseOpenCodeNativeModelCatalog(
        [
          'opencode-go/qwen3.7-max',
          'openai/gpt-5.6-luna',
          '{',
          '  "name": "GPT-5.6 Luna",',
          '  "variants": { "none": {}, "max": {} }',
          '}',
          'anthropic/claude-sonnet-4-6',
        ].join('\n'),
      ),
    ).toEqual({
      tool: 'opencode',
      models: [
        { selectionId: 'opencode-go/qwen3.7-max', nativeOrder: 0 },
        {
          selectionId: 'openai/gpt-5.6-luna',
          nativeOrder: 1,
          displayName: 'GPT-5.6 Luna',
          nativeReasoningEfforts: ['none', 'max'],
        },
        { selectionId: 'anthropic/claude-sonnet-4-6', nativeOrder: 2 },
      ],
    });
  });

  it('keeps a row whose verbose block publishes no context window', () => {
    // `kilo models --verbose` (kilo 7.0.49) published `"limit": { "context": 0 }`
    // for four image models on 2026-09-05; the row is real, the window is not.
    expect(
      parseKiloNativeModelCatalog(
        [
          'openai/gpt-image-2',
          '{',
          '  "name": "gpt-image-2",',
          '  "limit": { "context": 0, "input": 0, "output": 0 }',
          '}',
        ].join('\n'),
      ),
    ).toEqual({
      tool: 'kilo-code',
      models: [{ selectionId: 'openai/gpt-image-2', nativeOrder: 0, displayName: 'gpt-image-2' }],
    });
  });

  it('fails closed when a verbose block is truncated, is not JSON, or drifts in shape', () => {
    expect(
      parseOpenCodeNativeModelCatalog('openai/gpt-5.6-luna\n{\n  "name": "GPT-5.6 Luna",'),
    ).toBeNull();
    expect(parseKiloNativeModelCatalog('kilo/openai/gpt-5.6-luna\n{\n  "name": ,\n}')).toBeNull();
    expect(
      parseOpenCodeNativeModelCatalog(
        'openai/gpt-5.6-luna\n{\n  "limit": { "context": "500000" }\n}',
      ),
    ).toBeNull();
  });

  it('parses Cursor id-dash-name rows from the admitted listing fixture', () => {
    const stdout = readFileSync(
      join(import.meta.dirname, '../../../testing/fixtures/cursor/list-models.txt'),
      'utf-8',
    );
    const catalog = parseCursorNativeModelCatalog(stdout);
    if (catalog === null) throw new Error('Expected admitted Cursor fixture to parse');

    expect(catalog.tool).toBe('cursor');
    expect(catalog.models[0]).toEqual({
      selectionId: 'auto',
      displayName: 'Auto',
      nativeOrder: 0,
      nativeDefault: true,
    });
    expect(catalog.models.some((model) => model.selectionId.startsWith('Tip'))).toBe(false);
    expect(nativeCliCatalogToDetectedModels(catalog)[0]).toEqual({
      id: 'auto',
      displayName: 'Auto',
      nativeOrder: 0,
      nativeDefault: true,
    });
    expect(parseCursorNativeModelCatalog('Usage: cursor-agent --list-models')).toBeNull();
    expect(parseCursorNativeModelCatalog('Available models\n\n')).toBeNull();
  });

  it('parses Command Code rows from the recorded listing fixture', () => {
    const stdout = readFileSync(
      join(import.meta.dirname, '../../../testing/fixtures/command-code/list-models.txt'),
      'utf-8',
    );
    const catalog = parseCommandCodeNativeModelCatalog(stdout);
    if (catalog === null) throw new Error('Expected the Command Code fixture to parse');

    expect(catalog.tool).toBe('command-code');
    // The listing states its own count, so the row total is checked against it.
    expect(catalog.models).toHaveLength(61);
    expect(catalog.models[0]).toEqual({
      selectionId: 'deepseek/deepseek-v4-pro',
      nativeOrder: 0,
    });
    // First-party ids drop the `provider/` prefix; both shapes are selectable.
    expect(catalog.models.some((model) => model.selectionId === 'claude-sonnet-5')).toBe(true);
    // Provider headings, the `cmd --model …` usage examples and the trailing
    // `Docs:` line are not rows.
    expect(
      catalog.models.some((model) =>
        ['Open', 'Anthropic', 'cmd', 'Docs:'].includes(model.selectionId),
      ),
    ).toBe(false);
    expect(
      catalog.models.find((model) => model.selectionId === 'deepseek/deepseek-v4-flash'),
    ).toEqual({
      selectionId: 'deepseek/deepseek-v4-flash',
      nativeOrder: 1,
      nativeDefault: true,
    });
    expect(
      catalog.models
        .filter((model) => model.selectionId !== 'deepseek/deepseek-v4-flash')
        .every((model) => model.nativeDefault === undefined),
    ).toBe(true);
    expect(nativeCliCatalogToDetectedModels(catalog)[0]).toEqual({
      id: 'deepseek/deepseek-v4-pro',
      nativeOrder: 0,
    });
    expect(parseCommandCodeNativeModelCatalog('Usage: cmd --list-models')).toBeNull();
    expect(parseCommandCodeNativeModelCatalog('Available models\n\n')).toBeNull();
  });

  it('leaves an unrelated trailing parenthetical on the display name', () => {
    const stdout = readFileSync(
      join(import.meta.dirname, '../../../testing/fixtures/cursor/list-models.txt'),
      'utf-8',
    );
    const catalog = parseCursorNativeModelCatalog(stdout);
    if (catalog === null) throw new Error('Expected admitted Cursor fixture to parse');

    const row = catalog.models.find(
      (model) => model.selectionId === 'claude-fable-5-thinking-high',
    );
    if (row === undefined) throw new Error('Expected the Claude Fable row in the Cursor fixture');

    expect(row.displayName).toBe('Claude Fable 5 1M Thinking (NO ZDR)');
    expect(row.nativeDefault).toBeUndefined();
  });

  it('marks at most one row as the native default per listing', () => {
    const cursor = parseCursorNativeModelCatalog(
      readFileSync(
        join(import.meta.dirname, '../../../testing/fixtures/cursor/list-models.txt'),
        'utf-8',
      ),
    );
    const commandCode = parseCommandCodeNativeModelCatalog(
      readFileSync(
        join(import.meta.dirname, '../../../testing/fixtures/command-code/list-models.txt'),
        'utf-8',
      ),
    );
    if (cursor === null || commandCode === null) throw new Error('Expected both fixtures to parse');

    expect(cursor.models.filter((model) => model.nativeDefault === true)).toHaveLength(1);
    expect(commandCode.models.filter((model) => model.nativeDefault === true)).toHaveLength(1);
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
  });

  describe('parseCopilotHelpConfigCatalog', () => {
    it('reads the model enum from the recorded help output in the order the tool prints it', () => {
      const stdout = readFileSync(
        join(import.meta.dirname, '../../../testing/fixtures/copilot/help-config.txt'),
        'utf-8',
      );
      const catalog = parseCopilotHelpConfigCatalog(stdout);
      if (catalog === null) throw new Error('Expected the copilot help config fixture to parse');

      expect(catalog.tool).toBe('copilot');
      expect(catalog.models.map((model) => model.selectionId)).toEqual([
        'claude-sonnet-5',
        'claude-sonnet-4.6',
        'claude-sonnet-4.5',
        'claude-haiku-4.5',
        'claude-fable-5',
        'claude-opus-5',
        'claude-opus-4.8',
        'claude-opus-4.8-fast',
        'claude-opus-4.7',
        'claude-opus-4.6',
        'claude-opus-4.5',
        'gpt-5.6-sol',
        'gpt-5.6-terra',
        'gpt-5.6-luna',
        'gpt-5.5',
        'gpt-5.4',
        'gpt-5.3-codex',
        'gpt-5.4-mini',
        'gpt-5-mini',
        'mai-code-1-flash-picker',
        'gemini-3.1-pro-preview',
        'gemini-3.6-flash',
        'gemini-3.5-flash',
        'grok-4.5',
        'kimi-k2.7-code',
      ]);
      expect(catalog.models.map((model) => model.nativeOrder)).toEqual(
        Array.from({ length: 25 }, (_, index) => index),
      );
    });

    it('stops at the config key that follows the enum', () => {
      const catalog = parseCopilotHelpConfigCatalog(
        [
          '  `model`: AI model to use for Copilot CLI.',
          '    - "gpt-5.5"',
          '  `contextTier`: context window tier for tiered-pricing models.',
          '    - "long_context"',
        ].join('\n'),
      );

      expect(catalog?.models.map((model) => model.selectionId)).toEqual(['gpt-5.5']);
    });

    it('returns null when the help output carries no readable model enum', () => {
      expect(
        parseCopilotHelpConfigCatalog(
          'Configuration Settings:\n\n  `banner`: frequency of showing animated banner.',
        ),
      ).toBeNull();
      expect(
        parseCopilotHelpConfigCatalog('  `model`: AI model to use for Copilot CLI.'),
      ).toBeNull();
    });
  });

  describe('codex supported_reasoning_levels', () => {
    it('reads the per-model ladder and default the bundled listing publishes', () => {
      const catalog = parseCodexNativeModelCatalog(JSON.stringify(CODEX_BUNDLED_SLICE));
      if (catalog === null) throw new Error('Expected the bundled Codex slice to parse');

      expect(catalog.models[0]).toEqual({
        selectionId: 'gpt-5.6-sol',
        displayName: 'GPT-5.6-Sol',
        nativeOrder: 0,
        nativeReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
        nativeDefaultReasoningEffort: 'low',
      });
      expect(catalog.models[1]).toEqual({
        selectionId: 'gpt-5.5',
        displayName: 'GPT-5.5',
        nativeOrder: 1,
        nativeReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
        nativeDefaultReasoningEffort: 'medium',
      });
    });

    it('keeps the ultra rung the configurable effort enum cannot represent', () => {
      // SPEC-D5: the parser reports what the tool publishes; gating is a different sprint's job.
      const catalog = parseCodexNativeModelCatalog(JSON.stringify(CODEX_BUNDLED_SLICE));
      if (catalog === null) throw new Error('Expected the bundled Codex slice to parse');

      expect(catalog.models[0]?.nativeReasoningEfforts).toContain('ultra');
    });

    it('fails closed when the two reasoning sources disagree', () => {
      expect(
        parseCodexNativeModelCatalog(
          JSON.stringify({
            models: [
              {
                slug: 'gpt-5.6-sol',
                reasoning_efforts: ['low', 'medium'],
                supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }],
              },
            ],
          }),
        ),
      ).toBeNull();
    });

    it('reads a default with no ladder', () => {
      const catalog = parseCodexNativeModelCatalog(
        JSON.stringify({
          models: [{ slug: 'gpt-5.5', default_reasoning_level: 'medium' }],
        }),
      );
      if (catalog === null) throw new Error('Expected the default-only fixture to parse');

      expect(catalog.models[0]?.nativeDefaultReasoningEffort).toBe('medium');
      expect(catalog.models[0]).not.toHaveProperty('nativeReasoningEfforts');
    });

    it('carries the default through the strict DetectedModel boundary', () => {
      const catalog = parseCodexNativeModelCatalog(JSON.stringify(CODEX_BUNDLED_SLICE));
      if (catalog === null) throw new Error('Expected the bundled Codex slice to parse');

      const [detected] = nativeCliCatalogToDetectedModels(catalog);
      if (detected === undefined) throw new Error('Expected one detected model');

      expect(detected).toEqual({
        id: 'gpt-5.6-sol',
        displayName: 'GPT-5.6-Sol',
        nativeOrder: 0,
        nativeReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
        supportsReasoning: true,
        nativeDefaultReasoningEffort: 'low',
      });
      const parsed = DetectedModelSchema.parse(detected);
      expect(parsed.nativeDefaultReasoningEffort).toBe('low');
    });
  });
});
