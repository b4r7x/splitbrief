import { describe, expect, it } from 'vitest';
import { buildRunnerConfig } from './build-runner.js';

describe('buildRunnerConfig', () => {
  describe('kind from explicit hint', () => {
    it('uses explicit kind: cli', () => {
      const result = buildRunnerConfig('planner', {
        kind: 'cli',
        tool: 'claude-code',
      });
      expect(result.kind).toBe('cli');
      expect((result as any).tool).toBe('claude-code');
    });

    it('uses explicit kind: api', () => {
      const result = buildRunnerConfig('implementer', {
        kind: 'api',
        tool: 'ollama', // tool becomes provider for api
        apiBase: 'http://localhost:11434/v1',
        model: 'qwen2.5:7b',
      });
      expect(result.kind).toBe('api');
      expect((result as any).provider).toBe('ollama');
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
  });

  describe('apiBase auto-fill for known providers', () => {
    it('auto-fills apiBase for ollama', () => {
      const result = buildRunnerConfig('implementer', {
        kind: 'api',
        tool: 'ollama',
        model: 'qwen2.5:7b',
      });
      expect((result as any).apiBase).toBe('http://localhost:11434/v1');
    });

    it('auto-fills apiBase for lm-studio', () => {
      const result = buildRunnerConfig('implementer', {
        kind: 'api',
        tool: 'lm-studio',
        model: 'test',
      });
      expect((result as any).apiBase).toBe('http://localhost:1234/v1');
    });
  });

  describe('unknown provider errors', () => {
    it('throws for unknown provider without apiBase', () => {
      expect(() =>
        buildRunnerConfig('implementer', {
          kind: 'api',
          tool: 'my-custom-provider',
          model: 'test',
        })
      ).toThrow(/apiBase/);
    });

    it('accepts unknown provider with explicit apiBase', () => {
      const result = buildRunnerConfig('implementer', {
        kind: 'api',
        tool: 'my-custom-provider',
        apiBase: 'http://my-server:8080/v1',
        model: 'test',
      });
      expect((result as any).provider).toBe('my-custom-provider');
      expect((result as any).apiBase).toBe('http://my-server:8080/v1');
    });
  });

  describe('kind inference errors', () => {
    it('throws when kind cannot be inferred from any field', () => {
      expect(() =>
        buildRunnerConfig('planner', {})
      ).toThrow(/Cannot infer runner kind for planner/);
    });

    it('throws with the role in the message', () => {
      expect(() =>
        buildRunnerConfig('implementer', {})
      ).toThrow(/Cannot infer runner kind for implementer/);
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
      expect((result as any).temperature).toBe(0.3);
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
        })
      ).toThrow(/tool/);
    });

    it('throws for shell without command', () => {
      expect(() =>
        buildRunnerConfig('planner', {
          kind: 'shell',
        })
      ).toThrow(/command/);
    });

    it('throws for implementer without model', () => {
      expect(() =>
        buildRunnerConfig('implementer', {
          kind: 'api',
          tool: 'ollama',
        })
      ).toThrow(/model/);
    });
  });
});
