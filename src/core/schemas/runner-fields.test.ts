import { describe, expect, it } from 'vitest';
import {
  GenerationCommonFields,
  createRunnerConfigSchema,
} from './runner-fields.js';

describe('createRunnerConfigSchema', () => {
  it('accepts the runner config shapes users can put in config files', () => {
    const schema = createRunnerConfigSchema(GenerationCommonFields);

    expect([
      schema.safeParse({ kind: 'cli', tool: 'codex', model: 'gpt-5', args: ['--quiet'], outputFormat: 'jsonl' }).success,
      schema.safeParse({ kind: 'api', provider: 'openai', apiBase: 'https://api.openai.com/v1', apiKey: 'env:OPENAI_API_KEY', model: 'gpt-5-mini' }).success,
      schema.safeParse({ kind: 'shell', command: './run-planner', args: ['--json'], model: 'local-shell' }).success,
      schema.safeParse({ kind: 'agent', command: 'my-agent', capabilities: { supportsEffort: true }, model: 'agent-default' }).success,
      schema.safeParse({ kind: 'agent-sdk', apiKey: 'env:ANTHROPIC_API_KEY', model: 'claude-sonnet-4-5' }).success,
    ]).toEqual([true, true, true, true, true]);
  });

  it('rejects unknown and incomplete runner config payloads', () => {
    const schema = createRunnerConfigSchema(GenerationCommonFields);
    expect(schema.safeParse({ kind: 'unknown', model: 'x' }).success).toBe(false);
    expect(schema.safeParse({ kind: 'shell', model: 'x' }).success).toBe(false);
    expect(schema.safeParse({ kind: 'api', provider: 'openai', model: 'x' }).success).toBe(false);
  });

  it('rejects unknown keys so misspelled config does not silently pass', () => {
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
