import { describe, expect, it } from 'vitest';
import { ImplementerConfigSchema } from './implementer-config.js';
import type { CliImplementerConfig, ApiImplementerConfig } from './implementer-config.js';
import { ZodError } from 'zod';

describe('ImplementerConfigSchema', () => {
  describe('cli variant', () => {
    it('parses valid cli config', () => {
      const result = ImplementerConfigSchema.parse({
        kind: 'cli',
        tool: 'claude-code',
        model: 'opus-4',
      }) as CliImplementerConfig;
      expect(result.kind).toBe('cli');
      expect(result.tool).toBe('claude-code');
    });

    it('rejects cli with unknown tool', () => {
      expect(() =>
        ImplementerConfigSchema.parse({
          kind: 'cli',
          tool: 'unknown-tool',
          model: 'test',
        }),
      ).toThrow(ZodError);
    });

    it('rejects cli with provider field', () => {
      expect(() =>
        ImplementerConfigSchema.parse({
          kind: 'cli',
          tool: 'claude-code',
          model: 'test',
          provider: 'ollama',
        }),
      ).toThrow(ZodError);
    });
  });

  describe('api variant', () => {
    it('parses valid api config', () => {
      const result = ImplementerConfigSchema.parse({
        kind: 'api',
        provider: 'ollama',
        apiBase: 'http://localhost:11434/v1',
        model: 'qwen2.5:7b',
      }) as ApiImplementerConfig;
      expect(result.kind).toBe('api');
      expect(result.provider).toBe('ollama');
    });

    it('rejects api without apiBase', () => {
      expect(() =>
        ImplementerConfigSchema.parse({
          kind: 'api',
          provider: 'ollama',
          model: 'test',
        }),
      ).toThrow(ZodError);
    });

    it('rejects api with tool field', () => {
      expect(() =>
        ImplementerConfigSchema.parse({
          kind: 'api',
          provider: 'ollama',
          apiBase: 'http://localhost:11434/v1',
          model: 'test',
          tool: 'claude-code',
        }),
      ).toThrow(ZodError);
    });

    it('rejects api without model (required for implementer)', () => {
      expect(() =>
        ImplementerConfigSchema.parse({
          kind: 'api',
          provider: 'ollama',
          apiBase: 'http://localhost:11434/v1',
        }),
      ).toThrow(ZodError);
    });
  });

  describe('shell variant', () => {
    it('parses valid shell config', () => {
      const result = ImplementerConfigSchema.parse({
        kind: 'shell',
        command: 'my-impl',
        model: 'test',
      });
      expect(result.kind).toBe('shell');
    });

    it('rejects shell with empty command', () => {
      expect(() =>
        ImplementerConfigSchema.parse({
          kind: 'shell',
          command: '',
          model: 'test',
        }),
      ).toThrow(ZodError);
    });
  });

  describe('agent variant', () => {
    it('parses valid agent config', () => {
      const result = ImplementerConfigSchema.parse({
        kind: 'agent',
        command: 'my-agent',
        model: 'test',
      });
      expect(result.kind).toBe('agent');
    });
  });

  describe('agent-sdk variant', () => {
    it('parses valid agent-sdk config', () => {
      const result = ImplementerConfigSchema.parse({
        kind: 'agent-sdk',
        model: 'opus-4',
      });
      expect(result.kind).toBe('agent-sdk');
    });
  });

  describe('missing kind', () => {
    it('rejects config without kind', () => {
      expect(() =>
        ImplementerConfigSchema.parse({
          tool: 'ollama',
          model: 'test',
        }),
      ).toThrow(ZodError);
    });
  });
});
