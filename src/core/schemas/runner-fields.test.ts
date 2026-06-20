import { describe, expect, it } from 'vitest';
import { PlannerConfigSchema } from './planner-config.js';
import {
  GenerationCommonFields,
  createPlannerConfigSchema,
  createRunnerConfigSchema,
} from './runner-fields.js';

describe('createRunnerConfigSchema', () => {
  it('accepts the runner config shapes users can put in config files', () => {
    const schema = createRunnerConfigSchema(GenerationCommonFields);

    expect([
      schema.safeParse({
        kind: 'cli',
        tool: 'codex',
        model: 'gpt-5',
        args: ['--quiet'],
        outputFormat: 'jsonl',
      }).success,
      schema.safeParse({
        kind: 'api',
        provider: 'openai',
        apiBase: 'https://api.openai.com/v1',
        apiKey: 'env:OPENAI_API_KEY',
        model: 'gpt-5-mini',
      }).success,
      schema.safeParse({
        kind: 'shell',
        command: './run-planner',
        args: ['--json'],
        model: 'local-shell',
      }).success,
      schema.safeParse({
        kind: 'agent',
        command: 'my-agent',
        model: 'agent-default',
      }).success,
      schema.safeParse({
        kind: 'agent-sdk',
        apiKey: 'env:ANTHROPIC_API_KEY',
        model: 'claude-sonnet-4-5',
      }).success,
    ]).toEqual([true, true, true, true, true]);
  });

  it('rejects the planner-only capabilities field on shell and agent runners', () => {
    const schema = createRunnerConfigSchema(GenerationCommonFields);

    expect(
      schema.safeParse({
        kind: 'shell',
        command: './run',
        model: 'local-shell',
        capabilities: { supportsEffort: true },
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        kind: 'agent',
        command: 'my-agent',
        model: 'agent-default',
        capabilities: { supportsSessionResume: true },
      }).success,
    ).toBe(false);
  });

  it('accepts supported orchestration-level planner capabilities on shell and agent planner runners', () => {
    const schema = createPlannerConfigSchema(GenerationCommonFields);

    expect(
      schema.safeParse({
        kind: 'shell',
        command: './run',
        model: 'local-shell',
        capabilities: { supportsHintEscalation: true },
      }).success,
    ).toBe(true);
    expect(
      schema.safeParse({
        kind: 'agent',
        command: 'my-agent',
        model: 'agent-default',
        capabilities: { supportsHintEscalation: true },
      }).success,
    ).toBe(true);
  });

  it('rejects supportsSessionResume/supportsEffort/supportsImages on shell and agent planners', () => {
    const shellResume = PlannerConfigSchema.safeParse({
      kind: 'shell',
      command: './run',
      model: 'local-shell',
      capabilities: { supportsSessionResume: true },
    });
    expect(shellResume.success).toBe(false);
    expect(shellResume.error?.issues[0]?.path).toEqual(['capabilities', 'supportsSessionResume']);
    expect(shellResume.error?.issues[0]?.message).toContain('session-handle contract');

    const agentResume = PlannerConfigSchema.safeParse({
      kind: 'agent',
      command: 'my-agent',
      model: 'agent-default',
      capabilities: { supportsSessionResume: true },
    });
    expect(agentResume.success).toBe(false);
    expect(agentResume.error?.issues[0]?.path).toEqual(['capabilities', 'supportsSessionResume']);

    const shellEffort = PlannerConfigSchema.safeParse({
      kind: 'shell',
      command: './run',
      model: 'local-shell',
      capabilities: { supportsEffort: true },
    });
    expect(shellEffort.success).toBe(false);
    expect(shellEffort.error?.issues[0]?.path).toEqual(['capabilities', 'supportsEffort']);

    expect(
      PlannerConfigSchema.safeParse({
        kind: 'shell',
        command: './run',
        model: 'local-shell',
        capabilities: { supportsImages: true },
      }).success,
    ).toBe(false);

    const agentImages = PlannerConfigSchema.safeParse({
      kind: 'agent',
      command: 'my-agent',
      model: 'agent-default',
      capabilities: { supportsImages: true },
    });
    expect(agentImages.success).toBe(false);
    expect(agentImages.error?.issues[0]?.path).toEqual(['capabilities', 'supportsImages']);
  });

  it('still accepts supportsEffort/supportsImages flags set to false on shell and agent planners', () => {
    expect(
      PlannerConfigSchema.safeParse({
        kind: 'shell',
        command: './run',
        model: 'local-shell',
        capabilities: { supportsEffort: false, supportsImages: false },
      }).success,
    ).toBe(true);
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
