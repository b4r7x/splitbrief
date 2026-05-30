import { describe, expect, it } from 'vitest';
import { expectApi, expectCli } from '#testing/helpers/config-narrowing.js';
import { buildRunnerConfig, inferKindFromTool } from './build-runner.js';

describe('buildRunnerConfig', () => {
  describe('kind from explicit hint', () => {
    it('uses explicit kind: cli', () => {
      const result = buildRunnerConfig('planner', {
        kind: 'cli',
        tool: 'claude-code',
      });
      expect(expectCli(result).tool).toBe('claude-code');
    });

    it('uses explicit kind: api', () => {
      const result = buildRunnerConfig('implementer', {
        kind: 'api',
        tool: 'ollama', // tool becomes provider for api
        apiBase: 'http://localhost:11434/v1',
        model: 'qwen2.5:7b',
      });
      expect(expectApi(result).provider).toBe('ollama');
    });
  });

  describe('kind inferred from shape', () => {
    it('infers cli from tool in CLI_TOOL_IDS', () => {
      const result = buildRunnerConfig('planner', {
        tool: 'claude-code',
      });
      expect(result.kind).toBe('cli');
    });

    it('infers api from apiBase presence', () => {
      const result = buildRunnerConfig('implementer', {
        apiBase: 'http://localhost:11434/v1',
        model: 'test',
      });
      expect(result.kind).toBe('api');
    });

    it('infers shell from command presence', () => {
      const result = buildRunnerConfig('planner', {
        command: 'my-planner',
      });
      expect(result.kind).toBe('shell');
    });

    it('infers agent from tool name', () => {
      const result = buildRunnerConfig('implementer', {
        tool: 'agent',
        command: 'custom-agent',
        model: 'claude-sonnet-4-6',
      });
      expect(result.kind).toBe('agent');
    });
  });

  describe('apiBase auto-fill for known providers', () => {
    it('auto-fills apiBase for ollama', () => {
      const result = buildRunnerConfig('implementer', {
        kind: 'api',
        tool: 'ollama',
        model: 'qwen2.5:7b',
      });
      expect(expectApi(result).apiBase).toBe('http://localhost:11434/v1');
    });

    it('auto-fills apiBase for lm-studio', () => {
      const result = buildRunnerConfig('implementer', {
        kind: 'api',
        tool: 'lm-studio',
        model: 'test',
      });
      expect(expectApi(result).apiBase).toBe('http://localhost:1234/v1');
    });

    it('does not reuse the previous provider apiBase when switching providers', () => {
      const result = buildRunnerConfig('implementer', {
        kind: 'api',
        tool: 'anthropic',
        model: 'claude-sonnet-4-6',
        existing: {
          kind: 'api',
          provider: 'openrouter',
          apiBase: 'https://openrouter.ai/api/v1',
          apiKey: 'openrouter-key',
          model: 'anthropic/claude-sonnet-4.6',
          contextLength: 8192,
        },
      });

      const api = expectApi(result);
      expect(api.apiBase).toBe('https://api.anthropic.com/v1');
      expect(api.apiKey).toBeUndefined();
    });
  });

  describe('unknown provider errors', () => {
    it('throws for unknown provider without apiBase', () => {
      expect(() =>
        buildRunnerConfig('implementer', {
          kind: 'api',
          tool: 'my-custom-provider',
          model: 'test',
        }),
      ).toThrow(/apiBase/);
    });

    it('accepts unknown provider with explicit apiBase', () => {
      const result = buildRunnerConfig('implementer', {
        kind: 'api',
        tool: 'my-custom-provider',
        apiBase: 'http://my-server:8080/v1',
        model: 'test',
      });
      const api = expectApi(result);
      expect(api.provider).toBe('my-custom-provider');
      expect(api.apiBase).toBe('http://my-server:8080/v1');
    });
  });

  describe('kind inference errors', () => {
    it('throws when kind cannot be inferred from any field', () => {
      expect(() => buildRunnerConfig('planner', {})).toThrow(
        /Cannot infer runner kind for planner/,
      );
    });

    it('throws with the role in the message', () => {
      expect(() => buildRunnerConfig('implementer', {})).toThrow(
        /Cannot infer runner kind for implementer/,
      );
    });
  });

  describe('generation params inherited from opts.existing', () => {
    it('inherits model from existing when not specified in opts', () => {
      const result = buildRunnerConfig('implementer', {
        existing: {
          kind: 'api',
          provider: 'ollama',
          apiBase: 'http://localhost:11434/v1',
          model: 'qwen2.5:7b',
          contextLength: 8192,
          temperature: 0.3,
        },
      });
      expect(result.model).toBe('qwen2.5:7b');
      expect(result.contextLength).toBe(8192);
      expect(expectApi(result).temperature).toBe(0.3);
    });

    it('opts.model overrides existing.model', () => {
      const result = buildRunnerConfig('implementer', {
        model: 'new-model',
        existing: {
          kind: 'api',
          provider: 'ollama',
          apiBase: 'http://localhost:11434/v1',
          model: 'old-model',
        },
      });
      expect(result.model).toBe('new-model');
    });
  });

  describe('missing required field errors', () => {
    it('throws for cli without tool', () => {
      expect(() =>
        buildRunnerConfig('planner', {
          kind: 'cli',
        }),
      ).toThrow(/tool/);
    });

    it('throws for shell without command', () => {
      expect(() =>
        buildRunnerConfig('planner', {
          kind: 'shell',
        }),
      ).toThrow(/command/);
    });

    it('throws for implementer without model', () => {
      expect(() =>
        buildRunnerConfig('implementer', {
          kind: 'api',
          tool: 'ollama',
        }),
      ).toThrow(/model/);
    });
  });
});

describe('inferKindFromTool', () => {
  it('returns cli for known CLI tools', () => {
    expect(inferKindFromTool('claude-code')).toBe('cli');
    expect(inferKindFromTool('codex')).toBe('cli');
    expect(inferKindFromTool('aider')).toBe('cli');
  });

  it('returns shell for shell meta-id', () => {
    expect(inferKindFromTool('shell')).toBe('shell');
  });

  it('returns agent for agent meta-id', () => {
    expect(inferKindFromTool('agent')).toBe('agent');
  });

  it('returns agent-sdk for agent-sdk', () => {
    expect(inferKindFromTool('agent-sdk')).toBe('agent-sdk');
  });

  it('returns api for known API providers', () => {
    expect(inferKindFromTool('anthropic')).toBe('api');
    expect(inferKindFromTool('ollama')).toBe('api');
    expect(inferKindFromTool('openrouter')).toBe('api');
  });

  it('returns api for unknown providers (custom endpoints)', () => {
    expect(inferKindFromTool('my-custom-provider')).toBe('api');
  });
});
