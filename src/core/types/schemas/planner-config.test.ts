import { describe, expect, it } from 'vitest';
import { PlannerConfigSchema } from './planner-config.js';
import { ZodError } from 'zod';

describe('PlannerConfigSchema', () => {
  describe('cli variant', () => {
    it('parses valid cli config', () => {
      const result = PlannerConfigSchema.parse({
        kind: 'cli',
        tool: 'claude-code',
        model: 'opus-4',
      });
      expect(result.kind).toBe('cli');
      if (result.kind === 'cli') {
        expect(result.tool).toBe('claude-code');
      }
    });

    it('rejects cli with unknown tool', () => {
      expect(() => PlannerConfigSchema.parse({
        kind: 'cli',
        tool: 'unknown-tool',
      })).toThrow(ZodError);
    });

    it('rejects cli with provider field', () => {
      expect(() => PlannerConfigSchema.parse({
        kind: 'cli',
        tool: 'claude-code',
        provider: 'ollama', // invalid for cli
      })).toThrow(ZodError);
    });
  });

  describe('api variant', () => {
    it('parses valid api config', () => {
      const result = PlannerConfigSchema.parse({
        kind: 'api',
        provider: 'ollama',
        apiBase: 'http://localhost:11434/v1',
        model: 'llama3',
      });
      expect(result.kind).toBe('api');
      if (result.kind === 'api') {
        expect(result.provider).toBe('ollama');
      }
    });

    it('rejects api without apiBase', () => {
      expect(() => PlannerConfigSchema.parse({
        kind: 'api',
        provider: 'ollama',
      })).toThrow(ZodError);
    });

    it('rejects api with tool field', () => {
      expect(() => PlannerConfigSchema.parse({
        kind: 'api',
        provider: 'ollama',
        apiBase: 'http://localhost:11434/v1',
        tool: 'claude-code', // invalid for api
      })).toThrow(ZodError);
    });
  });

  describe('shell variant', () => {
    it('parses valid shell config', () => {
      const result = PlannerConfigSchema.parse({
        kind: 'shell',
        command: 'my-planner',
      });
      expect(result.kind).toBe('shell');
      if (result.kind === 'shell') {
        expect(result.command).toBe('my-planner');
      }
    });

    it('rejects shell with empty command', () => {
      expect(() => PlannerConfigSchema.parse({
        kind: 'shell',
        command: '',
      })).toThrow(ZodError);
    });
  });

  describe('agent variant', () => {
    it('parses valid agent config', () => {
      const result = PlannerConfigSchema.parse({
        kind: 'agent',
        command: 'my-agent',
      });
      expect(result.kind).toBe('agent');
    });
  });

  describe('agent-sdk variant', () => {
    it('parses valid agent-sdk config', () => {
      const result = PlannerConfigSchema.parse({
        kind: 'agent-sdk',
      });
      expect(result.kind).toBe('agent-sdk');
    });
  });

  describe('missing kind', () => {
    it('rejects config without kind', () => {
      expect(() => PlannerConfigSchema.parse({
        tool: 'claude-code',
      })).toThrow(ZodError);
    });
  });
});
