import { describe, expect, it } from 'vitest';
import type { RunnerConfig } from '../config/accessors/runner-config.js';
import { opencodeVariantChoices } from './variant-vocabulary.js';

function seat(tool: 'opencode' | 'kilo-code', model: string): RunnerConfig {
  return { kind: 'cli', tool, model };
}

describe('opencodeVariantChoices', () => {
  it('offers the OpenAI preset ladder verbatim', () => {
    expect(opencodeVariantChoices(seat('opencode', 'openai/gpt-5.6-luna'))).toEqual([
      'none',
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
    ]);
  });

  it('offers only high and max on Anthropic', () => {
    expect(opencodeVariantChoices(seat('opencode', 'anthropic/claude-opus-4-8'))).toEqual([
      'high',
      'max',
    ]);
  });

  it('offers only low and high on Google', () => {
    expect(opencodeVariantChoices(seat('opencode', 'google/gemini-3.5-pro'))).toEqual([
      'low',
      'high',
    ]);
  });

  it('offers nothing for a gateway prefix the table does not name', () => {
    expect(opencodeVariantChoices(seat('opencode', 'opencode-go/gpt-5.6-luna'))).toEqual([]);
  });

  it('offers nothing for an unprefixed id', () => {
    expect(opencodeVariantChoices(seat('opencode', 'gpt-5.6-luna'))).toEqual([]);
  });

  // `kilo models --verbose` (7.0.49, 2026-09-08) publishes presets per model, and 85 of its 121
  // routes disagree with this per-provider table. `openai/gpt-5.6` is the one the tool guard
  // earns its keep on: kilo ids carry the same provider segments, so the table would hand that
  // seat an extra `minimal` kilo does not publish for it. `github-copilot/gpt-5.4` is the other
  // direction — kilo publishes `low, medium, high` where the table names no `github-copilot` —
  // and `kilo/cohere/north-mini-code:free` publishes `instant, thinking`, words it cannot spell.
  it.each([['openai/gpt-5.6'], ['github-copilot/gpt-5.4'], ['kilo/cohere/north-mini-code:free']])(
    'answers nothing for the kilo seat on %s — kilo publishes its own presets',
    (model) => {
      expect(opencodeVariantChoices(seat('kilo-code', model))).toEqual([]);
    },
  );

  it('answers nothing for a seat that carries no cli tool at all', () => {
    expect(
      opencodeVariantChoices({
        kind: 'api',
        provider: 'ollama',
        service: 'ollama',
        offering: 'local',
        apiBase: 'http://127.0.0.1:11434/v1',
        model: 'openai/gpt-5.6-luna',
      }),
    ).toEqual([]);
  });
});
