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

  it('rejects {prompt} in shell and agent command strings', () => {
    const schema = createRunnerConfigSchema(GenerationCommonFields);

    for (const kind of ['shell', 'agent'] as const) {
      const result = schema.safeParse({
        kind,
        command: `./run-{prompt}`,
        model: 'local-command',
      });

      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.path).toEqual(['command']);
      expect(result.error?.issues[0]?.message).toContain('must not contain {prompt}');
    }
  });

  it('allows {prompt} in shell and agent args', () => {
    const schema = createRunnerConfigSchema(GenerationCommonFields);

    expect(
      schema.safeParse({
        kind: 'shell',
        command: './run',
        args: ['--prompt', '{prompt}'],
        model: 'local-shell',
      }).success,
    ).toBe(true);
    expect(
      schema.safeParse({
        kind: 'agent',
        command: './agent',
        args: ['--prompt={prompt}'],
        model: 'local-agent',
      }).success,
    ).toBe(true);
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

  it('cli, shell, agent, and agent-sdk runners accept idleWarnMs and idleKillMs', () => {
    const schema = createRunnerConfigSchema(GenerationCommonFields);

    expect([
      schema.safeParse({
        kind: 'cli',
        tool: 'codex',
        model: 'gpt-5',
        idleWarnMs: 60_000,
        idleKillMs: 300_000,
      }).success,
      schema.safeParse({
        kind: 'shell',
        command: './run',
        model: 'local-shell',
        idleWarnMs: 60_000,
        idleKillMs: 300_000,
      }).success,
      schema.safeParse({
        kind: 'agent',
        command: 'my-agent',
        model: 'agent-default',
        idleWarnMs: 60_000,
        idleKillMs: 300_000,
      }).success,
      schema.safeParse({
        kind: 'agent-sdk',
        apiKey: 'env:ANTHROPIC_API_KEY',
        model: 'claude-sonnet-4-5',
        idleWarnMs: 60_000,
        idleKillMs: 300_000,
      }).success,
    ]).toEqual([true, true, true, true]);
  });

  it('rejects fractional idle thresholds — stall events carry integer silentMs', () => {
    const schema = createRunnerConfigSchema(GenerationCommonFields);

    expect(
      schema.safeParse({
        kind: 'cli',
        tool: 'codex',
        model: 'gpt-5',
        idleWarnMs: 60_000.5,
        idleKillMs: 300_000,
      }).success,
    ).toBe(false);

    expect(
      schema.safeParse({
        kind: 'shell',
        command: './run',
        model: 'local-shell',
        idleKillMs: 300_000.5,
      }).success,
    ).toBe(false);
  });

  it('rejects idleKillMs below idleWarnMs and accepts ordered thresholds', () => {
    const schema = createRunnerConfigSchema(GenerationCommonFields);

    const misordered = schema.safeParse({
      kind: 'cli',
      tool: 'codex',
      model: 'gpt-5',
      idleWarnMs: 60_000,
      idleKillMs: 30_000,
    });
    expect(misordered.success).toBe(false);
    expect(misordered.error?.issues[0]?.path).toEqual(['idleKillMs']);
    expect(misordered.error?.issues[0]?.message).toContain('idleKillMs must be at least');

    expect(
      schema.safeParse({
        kind: 'cli',
        tool: 'codex',
        model: 'gpt-5',
        idleWarnMs: 60_000,
        idleKillMs: 60_000,
      }).success,
    ).toBe(true);
  });

  it('a lone threshold is validated against the other default: a kill below the default warn is rejected', () => {
    const schema = createRunnerConfigSchema(GenerationCommonFields);

    // idleKillMs alone below the 5min default warn would kill the runner before
    // the warning ever fires — the exact silent-kill case the ordering protects.
    const killBelowDefaultWarn = schema.safeParse({
      kind: 'shell',
      command: './run',
      model: 'local-shell',
      idleKillMs: 30_000,
    });
    expect(killBelowDefaultWarn.success).toBe(false);
    expect(killBelowDefaultWarn.error?.issues[0]?.message).toContain('idleKillMs must be at least');

    // idleWarnMs alone above the 30min default kill arms a warning that can
    // never fire before the default kill.
    expect(
      schema.safeParse({
        kind: 'shell',
        command: './run',
        model: 'local-shell',
        idleWarnMs: 2_000_000,
      }).success,
    ).toBe(false);

    expect(
      schema.safeParse({
        kind: 'shell',
        command: './run',
        model: 'local-shell',
        idleKillMs: 600_000,
      }).success,
    ).toBe(true);
    expect(
      schema.safeParse({
        kind: 'shell',
        command: './run',
        model: 'local-shell',
        idleWarnMs: 120_000,
      }).success,
    ).toBe(true);
  });

  it('api runners reject idleWarnMs and idleKillMs', () => {
    const schema = createRunnerConfigSchema(GenerationCommonFields);

    const result = schema.safeParse({
      kind: 'api',
      provider: 'openai',
      apiBase: 'https://api.openai.com/v1',
      model: 'gpt-5-mini',
      idleWarnMs: 60_000,
      idleKillMs: 300_000,
    });

    expect(result.success).toBe(false);
  });
});
