import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { RUNNER_KINDS } from './enums.js';
import {
  RUNNER_DESCRIPTORS,
  GenerationCommonFields,
  createRunnerConfigSchema,
  getRunnerKindMeta,
} from './runner-fields.js';

describe('RUNNER_DESCRIPTORS', () => {
  it('has an entry for every runner kind', () => {
    for (const kind of RUNNER_KINDS) {
      expect(RUNNER_DESCRIPTORS).toHaveProperty(kind);
      expect(RUNNER_DESCRIPTORS[kind].fields).toBeDefined();
    }
  });

  it('each entry has a kind literal matching its key', () => {
    for (const kind of RUNNER_KINDS) {
      const kindField = RUNNER_DESCRIPTORS[kind].fields.kind;
      const parsed = kindField.parse(kind);
      expect(parsed).toBe(kind);
    }
  });

  it('command-based kinds have requiresCommand: true', () => {
    expect(RUNNER_DESCRIPTORS.shell.requiresCommand).toBe(true);
    expect(RUNNER_DESCRIPTORS.agent.requiresCommand).toBe(true);
  });

  it('non-command kinds have requiresCommand: false', () => {
    expect(RUNNER_DESCRIPTORS.cli.requiresCommand).toBe(false);
    expect(RUNNER_DESCRIPTORS.api.requiresCommand).toBe(false);
    expect(RUNNER_DESCRIPTORS['agent-sdk'].requiresCommand).toBe(false);
  });

  it('api and agent-sdk have usesApiKey: true', () => {
    expect(RUNNER_DESCRIPTORS.api.usesApiKey).toBe(true);
    expect(RUNNER_DESCRIPTORS['agent-sdk'].usesApiKey).toBe(true);
  });
});

describe('getRunnerKindMeta', () => {
  it('returns metadata for each runner kind', () => {
    for (const kind of RUNNER_KINDS) {
      const meta = getRunnerKindMeta(kind);
      expect(meta).toHaveProperty('usesArgsOutputFormat');
      expect(meta).toHaveProperty('usesApiKey');
      expect(meta).toHaveProperty('requiresCommand');
    }
  });
});

describe('createRunnerConfigSchema', () => {
  it('creates a discriminated union covering all runner kinds', () => {
    const schema = createRunnerConfigSchema(GenerationCommonFields);
    for (const kind of RUNNER_KINDS) {
      const minimalValid = buildMinimalConfig(kind);
      const result = schema.safeParse(minimalValid);
      expect(result.success, `kind '${kind}' should parse: ${JSON.stringify(result)}`).toBe(true);
    }
  });

  it('rejects unknown kind values', () => {
    const schema = createRunnerConfigSchema(GenerationCommonFields);
    const result = schema.safeParse({ kind: 'unknown', model: 'x' });
    expect(result.success).toBe(false);
  });

  it('respects common field overrides (e.g., optional model)', () => {
    const optionalModelFields = {
      ...GenerationCommonFields,
      model: z.string().min(1).optional(),
    };
    const schema = createRunnerConfigSchema(optionalModelFields);
    const result = schema.safeParse({ kind: 'cli', tool: 'claude-code' });
    expect(result.success).toBe(true);
  });

  it('enforces strict mode (rejects extra fields)', () => {
    const schema = createRunnerConfigSchema(GenerationCommonFields);
    const result = schema.safeParse({
      kind: 'cli',
      tool: 'claude-code',
      model: 'test',
      extraField: 'should-fail',
    });
    expect(result.success).toBe(false);
  });
});

function buildMinimalConfig(kind: string): Record<string, unknown> {
  switch (kind) {
    case 'cli':
      return { kind: 'cli', tool: 'claude-code', model: 'test' };
    case 'api':
      return { kind: 'api', provider: 'ollama', apiBase: 'http://localhost:11434/v1', model: 'test' };
    case 'shell':
      return { kind: 'shell', command: 'my-shell', model: 'test' };
    case 'agent':
      return { kind: 'agent', command: 'my-agent', model: 'test' };
    case 'agent-sdk':
      return { kind: 'agent-sdk', model: 'test' };
    default:
      throw new Error(`Unknown kind: ${kind}`);
  }
}
