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
      if (result.kind === 'agent') {
        expect(result.command).toBe('custom-agent');
      }
    });

    it('builds implementer shell with the supplied command', () => {
      const result = buildRunnerConfig('implementer', {
        kind: 'shell',
        command: 'new-impl-cmd',
        model: 'llama3',
      });
      expect(result.kind).toBe('shell');
      if (result.kind === 'shell') {
        expect(result.command).toBe('new-impl-cmd');
      }
    });

    it('builds implementer agent with the supplied command', () => {
      const result = buildRunnerConfig('implementer', {
        kind: 'agent',
        command: 'new-agent-impl',
        model: 'llama3',
      });
      expect(result.kind).toBe('agent');
      if (result.kind === 'agent') {
        expect(result.command).toBe('new-agent-impl');
      }
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

    it('switching tool drops contextLength and temperature', () => {
      const result = buildRunnerConfig('implementer', {
        kind: 'api',
        tool: 'anthropic',
        model: 'qwen2.5:7b',
        existing: {
          kind: 'api',
          provider: 'ollama',
          apiBase: 'http://localhost:11434/v1',
          model: 'qwen2.5:7b',
          contextLength: 8192,
          temperature: 0.3,
        },
      });

      const api = expectApi(result);
      expect(api.contextLength).toBeUndefined();
      expect(api.temperature).toBeUndefined();
    });

    it('switching model on the same tool drops them', () => {
      const result = buildRunnerConfig('implementer', {
        kind: 'api',
        tool: 'ollama',
        model: 'new-model',
        existing: {
          kind: 'api',
          provider: 'ollama',
          apiBase: 'http://localhost:11434/v1',
          model: 'old-model',
          contextLength: 8192,
          temperature: 0.3,
        },
      });

      const api = expectApi(result);
      expect(api.contextLength).toBeUndefined();
      expect(api.temperature).toBeUndefined();
    });

    it('same target + same model keeps them', () => {
      const result = buildRunnerConfig('implementer', {
        kind: 'api',
        tool: 'ollama',
        model: 'qwen2.5:7b',
        existing: {
          kind: 'api',
          provider: 'ollama',
          apiBase: 'http://localhost:11434/v1',
          model: 'qwen2.5:7b',
          contextLength: 8192,
          temperature: 0.3,
        },
      });

      const api = expectApi(result);
      expect(api.contextLength).toBe(8192);
      expect(api.temperature).toBe(0.3);
    });

    it('timeout and customModels always carry', () => {
      const result = buildRunnerConfig('implementer', {
        kind: 'api',
        tool: 'anthropic',
        model: 'new-model',
        existing: {
          kind: 'api',
          provider: 'ollama',
          apiBase: 'http://localhost:11434/v1',
          model: 'old-model',
          contextLength: 8192,
          temperature: 0.3,
          timeout: 120000,
          customModels: ['old-model', 'other-model'],
        },
      });

      const api = expectApi(result);
      expect(api.timeout).toBe(120000);
      expect(api.customModels).toEqual(['old-model', 'other-model']);
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
  it.each([
    ['known CLI tool claude-code', 'claude-code', 'cli'],
    ['known CLI tool codex', 'codex', 'cli'],
    ['known CLI tool aider', 'aider', 'cli'],
    ['shell meta-runner', 'shell', 'shell'],
    ['agent meta-runner', 'agent', 'agent'],
    ['agent-sdk meta-runner', 'agent-sdk', 'agent-sdk'],
    ['known API provider anthropic', 'anthropic', 'api'],
    ['known API provider ollama', 'ollama', 'api'],
    ['known API provider openrouter', 'openrouter', 'api'],
    ['custom API provider', 'my-custom-provider', 'api'],
  ] as const)('%s', (_label, tool, kind) => {
    expect(inferKindFromTool(tool)).toBe(kind);
  });
});
