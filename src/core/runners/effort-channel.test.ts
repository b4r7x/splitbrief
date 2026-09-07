import { describe, expect, it } from 'vitest';
import { EFFORT_LEVELS } from '../schemas/enums.js';
import type { RunnerConfig } from '../config/accessors/runner-config.js';
import {
  EFFORT_AXIS_TOKENS,
  effortTokenOfModelId,
  optionTokensOfModelId,
  peelAxisTokensFromModelId,
  runnerEffortChannel,
  seatAxisWords,
} from './effort-channel.js';

const CURSOR_IDS = [
  'claude-opus-5-thinking-xhigh-fast',
  'claude-opus-5-thinking-high',
  'gpt-5.6-sol-xhigh-fast',
  'gpt-5.3-codex-low',
  'gpt-5.5-none',
  'gpt-5.5-extra-high-fast',
  'composer-2.5',
  'fast-1',
  'high-flyer-2',
  'openai/gpt-5.6-luna-high',
  'claude-opus-5-thinking-xhigh-fast ',
  'extra-high',
  'thinking-fast',
];

describe('EFFORT_AXIS_TOKENS', () => {
  it('is the effort vocabulary itself, not a second list', () => {
    expect(EFFORT_AXIS_TOKENS).toBe(EFFORT_LEVELS);
  });
});

describe('effortTokenOfModelId', () => {
  it('reads the effort token off a cursor-shaped id', () => {
    expect(effortTokenOfModelId('claude-opus-4-8-thinking-medium-fast')).toBe('medium');
    expect(effortTokenOfModelId('gpt-5.6-luna-xhigh')).toBe('xhigh');
    expect(effortTokenOfModelId('gemini-3.6-flash-minimal')).toBe('minimal');
  });

  it('folds extra-high into xhigh', () => {
    expect(effortTokenOfModelId('gpt-5.5-extra-high-fast')).toBe('xhigh');
  });

  it('reads through a provider prefix', () => {
    expect(effortTokenOfModelId('openai/gpt-5.6-luna-high')).toBe('high');
  });

  it('has no token for an id that spells none', () => {
    expect(effortTokenOfModelId('composer-2.5')).toBeUndefined();
    expect(effortTokenOfModelId('opencode/grok-code-fast')).toBeUndefined();
    expect(effortTokenOfModelId('muse-spark-1.2-contributor')).toBeUndefined();
  });

  it('has no token for undefined', () => {
    expect(effortTokenOfModelId(undefined)).toBeUndefined();
  });
});

describe('optionTokensOfModelId', () => {
  it('spells the axes a cursor id carries, effort first, then thinking, then fast', () => {
    expect(optionTokensOfModelId('claude-opus-5-thinking-xhigh-fast')).toEqual([
      'xhigh',
      'thinking',
      'fast',
    ]);
    expect(optionTokensOfModelId('gpt-5.6-sol-high')).toEqual(['high']);
    expect(optionTokensOfModelId('gpt-5.5-extra-high-fast')).toEqual(['xhigh', 'fast']);
  });

  it('reports none as the rung it is, not as an unset axis', () => {
    expect(optionTokensOfModelId('gpt-5.5-none')).toEqual(['none']);
  });

  it('spells nothing for an id that carries no trailing axis', () => {
    expect(optionTokensOfModelId('composer-2.5')).toEqual([]);
    expect(optionTokensOfModelId('fast-1')).toEqual([]);
    expect(optionTokensOfModelId('high-flyer-2')).toEqual([]);
    expect(optionTokensOfModelId(undefined)).toEqual([]);
  });

  it('reads a padded id the same way the peel does', () => {
    expect(optionTokensOfModelId('claude-opus-5-thinking-xhigh-fast ')).toEqual([
      'xhigh',
      'thinking',
      'fast',
    ]);
    expect(optionTokensOfModelId(' openai/gpt-5.6-luna-high ')).toEqual(['high']);
  });

  it('reports no axis for an id whose every token is one', () => {
    expect(optionTokensOfModelId('extra-high')).toEqual([]);
    expect(optionTokensOfModelId('thinking-fast')).toEqual([]);
    expect(optionTokensOfModelId('high')).toEqual([]);
  });

  it('reads only the trailing run, where the whole-id scan reads a family word', () => {
    expect(effortTokenOfModelId('high-flyer-2')).toBe('high');
    expect(optionTokensOfModelId('high-flyer-2')).toEqual([]);
    expect(peelAxisTokensFromModelId('high-flyer-2')).toBe('high-flyer-2');
  });
});

describe('peelAxisTokensFromModelId', () => {
  it('leaves the family behind and nothing else', () => {
    expect(peelAxisTokensFromModelId('claude-opus-5-thinking-xhigh-fast')).toBe('claude-opus-5');
    expect(peelAxisTokensFromModelId('gpt-5.3-codex-low')).toBe('gpt-5.3-codex');
    expect(peelAxisTokensFromModelId('gpt-5.5-none')).toBe('gpt-5.5');
    expect(peelAxisTokensFromModelId('gpt-5.5-extra-high-fast')).toBe('gpt-5.5');
  });

  it('leaves an id that carries no trailing axis exactly as it is', () => {
    expect(peelAxisTokensFromModelId('composer-2.5')).toBe('composer-2.5');
    expect(peelAxisTokensFromModelId('fast-1')).toBe('fast-1');
  });

  it('takes the whole trailing run, reporting the rung the tool would apply', () => {
    expect(optionTokensOfModelId('gpt-5.5-high-low')).toEqual(['low']);
    expect(peelAxisTokensFromModelId('gpt-5.5-high-low')).toBe('gpt-5.5');
  });

  it('keeps the provider prefix', () => {
    expect(peelAxisTokensFromModelId('openai/gpt-5.6-luna-high')).toBe('openai/gpt-5.6-luna');
    expect(peelAxisTokensFromModelId(' openai/gpt-5.6-luna-high ')).toBe('openai/gpt-5.6-luna');
  });

  it('keeps an id whose every token is an axis word whole', () => {
    expect(peelAxisTokensFromModelId('extra-high')).toBe('extra-high');
    expect(peelAxisTokensFromModelId('thinking-fast')).toBe('thinking-fast');
    expect(peelAxisTokensFromModelId('high')).toBe('high');
  });

  it('leaves behind nothing the identity would append a second time', () => {
    for (const id of CURSOR_IDS) {
      expect(optionTokensOfModelId(peelAxisTokensFromModelId(id))).toEqual([]);
    }
  });

  it('never empties an id, so the model word always has something to render', () => {
    for (const id of [...CURSOR_IDS, 'high', 'fast']) {
      expect(peelAxisTokensFromModelId(id)).not.toBe('');
    }
  });
});

describe('runnerEffortChannel', () => {
  it('names the channel each seat kind really uses', () => {
    expect(runnerEffortChannel({ kind: 'cli', tool: 'claude-code' })).toBe('effort-flag');
    expect(runnerEffortChannel({ kind: 'cli', tool: 'opencode' })).toBe('variant');
    expect(runnerEffortChannel({ kind: 'cli', tool: 'cursor' })).toBe('model-id');
    expect(runnerEffortChannel({ kind: 'cli', tool: 'codex' })).toBe('none');
    expect(
      runnerEffortChannel({
        kind: 'api',
        provider: 'ollama',
        service: 'ollama',
        offering: 'local',
        apiBase: 'http://127.0.0.1:11434/v1',
        model: 'qwen3-coder:30b',
      }),
    ).toBe('none');
    expect(runnerEffortChannel({ kind: 'shell', command: 'my-planner', model: 'whatever' })).toBe(
      'none',
    );
    expect(runnerEffortChannel({ kind: 'agent', command: 'my-agent', model: 'whatever' })).toBe(
      'none',
    );
  });
});

describe('seatAxisWords', () => {
  it('reads the effort field on a flag seat and the variant field on a variant seat', () => {
    const flag: RunnerConfig = { kind: 'cli', tool: 'claude-code', effort: 'xhigh' };
    const variant: RunnerConfig = { kind: 'cli', tool: 'opencode', variant: 'max' };

    expect(seatAxisWords(flag)).toEqual(['xhigh']);
    expect(seatAxisWords(variant)).toEqual(['max']);
  });

  it('reads the id on a cursor seat, none included', () => {
    expect(
      seatAxisWords({ kind: 'cli', tool: 'cursor', model: 'claude-opus-5-thinking-xhigh-fast' }),
    ).toEqual(['xhigh', 'thinking', 'fast']);
    expect(seatAxisWords({ kind: 'cli', tool: 'cursor', model: 'gpt-5.5-none' })).toEqual(['none']);
  });

  it('says nothing for a seat whose channel carries no effort, whatever the config holds', () => {
    expect(
      seatAxisWords({ kind: 'cli', tool: 'codex', model: 'gpt-5-codex', effort: 'high' }),
    ).toEqual([]);
    expect(seatAxisWords({ kind: 'cli', tool: 'claude-code', model: 'claude-sonnet-4' })).toEqual(
      [],
    );
    expect(seatAxisWords({ kind: 'cli', tool: 'opencode', model: 'openai/gpt-5.6-luna' })).toEqual(
      [],
    );
  });
});
