import { describe, expect, it } from 'vitest';
import { prettyModelName } from './pretty-model-name.js';

describe('prettyModelName', () => {
  it.each([
    ['claude-opus-5-5', 'Claude Opus 5.5'],
    ['deepseek-v4.1-flash', 'DeepSeek V4.1 Flash'],
    ['gpt-6-1-sol', 'GPT-6.1 Sol'],
    ['gpt-6.1-sol', 'GPT-6.1 Sol'],
    ['opencode-go/deepseek-v4.1-flash', 'DeepSeek V4.1 Flash'],
    ['openai/o3-mini', 'o3 Mini'],
    ['openai-codex-max', 'OpenAI Codex Max'],
    ['qwen2.5-coder:7b', 'Qwen2.5 Coder 7B'],
    ['gpt-oss:120b-cloud', 'GPT-OSS 120B Cloud'],
    ['opencode-go/glm-5.2', 'GLM 5.2'],
    ['mai-code-1.1-flash', 'MAI Code 1.1 Flash'],
    ['kilo/kilo-auto/free', 'Kilo Auto Free'],
    ['kilo/openrouter/free', 'OpenRouter Free'],
    ['openrouter/deepseek/deepseek-v4-flash', 'DeepSeek V4 Flash'],
    ['qwen/qwen3-coder', 'Qwen3 Coder'],
    ['openrouter/anthropic/claude-opus-4.5', 'Claude Opus 4.5'],
  ])('spells %s as %s', (id, name) => {
    expect(prettyModelName(id)).toBe(name);
  });
});
