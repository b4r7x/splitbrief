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

  describe('Claude Code onboarding channel', () => {
    it('persists the session channel for a newly selected Claude Code runner', () => {
      const result = buildRunnerConfig('planner', {
        kind: 'cli',
        tool: 'claude-code',
      });

      expect(expectCli(result).authChannel).toBe('session');
    });

    it('keeps an explicit API-key choice for Claude Code', () => {
      const existing = {
        kind: 'cli' as const,
        tool: 'codex' as const,
        authChannel: 'api-key' as const,
      };
      const selected = buildRunnerConfig('planner', {
        kind: 'cli',
        tool: 'claude-code',
        authChannel: 'api-key',
        existing,
      });
      const rebuilt = buildRunnerConfig('planner', {
        kind: 'cli',
        tool: 'claude-code',
        existing: selected,
      });

      expect(expectCli(selected).authChannel).toBe('api-key');
      expect(expectCli(rebuilt).authChannel).toBe('api-key');
    });

    it('does not add a channel while rebuilding a legacy Claude Code runner', () => {
      const legacy = { kind: 'cli' as const, tool: 'claude-code' as const, model: 'opus' };
      const rebuilt = buildRunnerConfig('planner', {
        kind: 'cli',
        tool: 'claude-code',
        existing: legacy,
      });

      expect(rebuilt).toEqual(legacy);
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

    it('normalizes an exact fixed provider endpoint', () => {
      const result = buildRunnerConfig('implementer', {
        kind: 'api',
        tool: 'openai',
        apiBase: 'HTTPS://API.OPENAI.COM:443/v1/',
        model: 'gpt-5.4',
      });

      expect(expectApi(result).apiBase).toBe('https://api.openai.com/v1');
    });

    it('normalizes a loopback provider endpoint', () => {
      const result = buildRunnerConfig('implementer', {
        kind: 'api',
        tool: 'ollama',
        apiBase: 'http://127.0.0.1:22000',
        model: 'qwen2.5:7b',
      });

      expect(expectApi(result).apiBase).toBe('http://127.0.0.1:22000/v1');
    });

    it('rejects a fixed provider endpoint on another origin', () => {
      expect(() =>
        buildRunnerConfig('implementer', {
          kind: 'api',
          tool: 'openai',
          apiBase: 'https://proxy.example.com/v1',
          model: 'gpt-5.4',
        }),
      ).toThrow(expect.objectContaining({ kind: 'provider-endpoint-invalid' }));
    });

    it('rejects a local provider endpoint outside loopback', () => {
      expect(() =>
        buildRunnerConfig('implementer', {
          kind: 'api',
          tool: 'ollama',
          apiBase: 'http://192.168.0.2:11434/v1',
          model: 'qwen2.5:7b',
        }),
      ).toThrow(expect.objectContaining({ kind: 'provider-endpoint-invalid' }));
    });

    it('does not reuse the previous provider apiBase when switching providers', () => {
      const result = buildRunnerConfig('implementer', {
        kind: 'api',
        tool: 'anthropic',
        model: 'claude-sonnet-4-6',
        existing: {
          kind: 'api',
          provider: 'openrouter',
          service: 'openrouter',
          offering: 'payg',
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
          service: 'ollama',
          offering: 'local',
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
          service: 'ollama',
          offering: 'local',
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
        model: 'claude-sonnet-4-6',
        existing: {
          kind: 'api',
          provider: 'ollama',
          service: 'ollama',
          offering: 'local',
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

    it('switching model on the same target preserves every other generation field', () => {
      const existing = {
        kind: 'api' as const,
        provider: 'ollama',
        service: 'ollama',
        offering: 'local' as const,
        apiBase: 'http://localhost:11434/v1',
        apiKey: 'env:OLLAMA_LOCAL_API_KEY',
        model: 'old-model',
        contextLength: 8192,
        temperature: 0.3,
        timeout: 120000,
        customModels: ['old-model', 'other-model'],
        effort: 'high' as const,
      };
      const result = buildRunnerConfig('implementer', {
        kind: 'api',
        tool: 'ollama',
        model: 'new-model',
        existing,
      });

      expect(result).toEqual({ ...existing, model: 'new-model' });
    });

    it('same target + same model keeps them', () => {
      const result = buildRunnerConfig('implementer', {
        kind: 'api',
        tool: 'ollama',
        model: 'qwen2.5:7b',
        existing: {
          kind: 'api',
          provider: 'ollama',
          service: 'ollama',
          offering: 'local',
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

    it('admits only the dedicated environment reference when constructing local Ollama', () => {
      const accepted = buildRunnerConfig('implementer', {
        kind: 'api',
        tool: 'ollama',
        model: 'local-model',
        apiKey: 'env:OLLAMA_LOCAL_API_KEY',
      });
      expect(expectApi(accepted).apiKey).toBe('env:OLLAMA_LOCAL_API_KEY');

      for (const apiKey of [
        'inline-local-secret',
        'env:ARBITRARY_LOCAL_KEY',
        'env:OLLAMA_API_KEY',
      ]) {
        expect(() =>
          buildRunnerConfig('implementer', {
            kind: 'api',
            tool: 'ollama',
            model: 'local-model',
            apiKey,
          }),
        ).toThrow(/OLLAMA_LOCAL_API_KEY/);
      }
    });

    it('carries timeout but resets source customModels across targets', () => {
      const result = buildRunnerConfig('implementer', {
        kind: 'api',
        tool: 'anthropic',
        model: 'new-model',
        existing: {
          kind: 'api',
          provider: 'ollama',
          service: 'ollama',
          offering: 'local',
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
      expect(api.customModels).toBeUndefined();
    });
  });

  describe('target changes', () => {
    const source = {
      kind: 'api' as const,
      provider: 'openrouter',
      service: 'openrouter',
      offering: 'payg' as const,
      apiBase: 'https://openrouter.ai/api/v1',
      apiKey: 'env:OPENROUTER_API_KEY',
      model: 'anthropic/claude-opus-4.6',
      customModels: ['anthropic/claude-opus-4.6', 'source-only-model'],
      effort: 'high' as const,
    };

    it('requires a destination model for a required target', () => {
      expect(() =>
        buildRunnerConfig('implementer', {
          kind: 'api',
          tool: 'anthropic',
          existing: source,
        }),
      ).toThrow(/model/);
    });

    it('keeps an explicit destination model even when it equals the source model', () => {
      const result = buildRunnerConfig('implementer', {
        kind: 'api',
        tool: 'anthropic',
        model: source.model,
        existing: source,
      });

      expect(result).toEqual({
        kind: 'api',
        provider: 'anthropic',
        service: 'anthropic',
        offering: 'payg',
        apiBase: 'https://api.anthropic.com/v1',
        model: source.model,
      });
    });

    it('keeps explicitly supplied destination custom models', () => {
      const destinationCustomModels = [...source.customModels];
      const result = buildRunnerConfig('implementer', {
        kind: 'cli',
        tool: 'codex',
        model: source.model,
        customModels: destinationCustomModels,
        existing: source,
      });

      expect(result).toEqual({
        kind: 'cli',
        tool: 'codex',
        model: source.model,
        customModels: destinationCustomModels,
      });
    });

    it('keeps an explicit destination model for an optional target', () => {
      const result = buildRunnerConfig('implementer', {
        kind: 'cli',
        tool: 'codex',
        model: 'gpt-5.4',
        existing: source,
      });

      expect(result).toEqual({ kind: 'cli', tool: 'codex', model: 'gpt-5.4' });
    });

    it('uses model absence when an optional CLI target delegates to its backend default', () => {
      const result = buildRunnerConfig('implementer', {
        kind: 'cli',
        tool: 'codex',
        existing: source,
      });

      expect(result).toEqual({ kind: 'cli', tool: 'codex' });
    });

    it('carries the auto sentinel to a CLI target without any source state', () => {
      const result = buildRunnerConfig('implementer', {
        kind: 'cli',
        tool: 'copilot',
        model: 'auto',
        existing: source,
      });

      expect(result).toEqual({ kind: 'cli', tool: 'copilot', model: 'auto' });
    });

    it('initializes a hosted target from its destination descriptor', () => {
      const result = buildRunnerConfig('implementer', {
        kind: 'api',
        tool: 'anthropic',
        model: 'claude-sonnet-4-6',
        apiBase: source.apiBase,
        apiKey: source.apiKey,
        service: source.service,
        offering: source.offering,
        effort: source.effort,
        existing: source,
      });

      expect(result).toEqual({
        kind: 'api',
        provider: 'anthropic',
        service: 'anthropic',
        offering: 'payg',
        apiBase: 'https://api.anthropic.com/v1',
        model: 'claude-sonnet-4-6',
      });
    });

    it('initializes a subscription target without API or auto state', () => {
      const result = buildRunnerConfig('implementer', {
        kind: 'cli',
        tool: 'copilot',
        effort: source.effort,
        existing: source,
      });

      expect(result).toEqual({ kind: 'cli', tool: 'copilot' });
    });

    it('initializes a local target from its destination descriptor', () => {
      const result = buildRunnerConfig('implementer', {
        kind: 'api',
        tool: 'ollama',
        model: 'qwen3-coder:30b',
        apiBase: source.apiBase,
        apiKey: source.apiKey,
        service: source.service,
        offering: source.offering,
        effort: source.effort,
        existing: source,
      });

      expect(result).toEqual({
        kind: 'api',
        provider: 'ollama',
        service: 'ollama',
        offering: 'local',
        apiBase: 'http://localhost:11434/v1',
        model: 'qwen3-coder:30b',
      });
    });

    it('does not carry planner capability state to a different command target', () => {
      const capabilities = {
        supportsConversationalPlanning: true,
        supportsHintEscalation: true,
      };
      const commandSource = {
        kind: 'shell' as const,
        command: 'source-planner',
        model: 'source-model',
        effort: 'high' as const,
        capabilities,
      };
      const result = buildRunnerConfig('planner', {
        kind: 'shell',
        command: 'destination-planner',
        effort: commandSource.effort,
        capabilities,
        existing: commandSource,
      });

      expect(result).toEqual({ kind: 'shell', command: 'destination-planner' });
    });

    it('resets inherited CLI auth channel when switching CLI targets', () => {
      const source = {
        kind: 'cli' as const,
        tool: 'codex' as const,
        authChannel: 'session' as const,
        model: 'source-model',
      };

      const result = buildRunnerConfig('implementer', {
        existing: source,
        tool: 'copilot',
        model: undefined,
      });

      expect(result).toEqual({ kind: 'cli', tool: 'copilot' });
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
