import { describe, expect, it } from 'vitest';
import { CLI_TOOL_TRUST } from '../runners/cli-tool-catalog.js';
import { PlannerConfigSchema } from './planner-config.js';
import {
  GenerationCommonFields,
  RUNNER_DESCRIPTORS,
  createCliModelPolicySchema,
  createPlannerConfigSchema,
  createRunnerConfigSchema,
  getRunnerKindMeta,
  getRunnerTrustMeta,
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
        service: 'openai',
        offering: 'payg',
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

  it('requires known API providers to state service and offering at runtime schema boundaries', () => {
    const providerOnly = {
      kind: 'api',
      provider: 'openrouter',
      apiBase: 'https://openrouter.ai/api/v1',
      model: 'anthropic/claude-sonnet-4',
    } as const;

    expect(createRunnerConfigSchema(GenerationCommonFields).safeParse(providerOnly).success).toBe(
      false,
    );
    expect(createPlannerConfigSchema(GenerationCommonFields).safeParse(providerOnly).success).toBe(
      false,
    );
  });

  it('requires custom API providers to state service and offering explicitly', () => {
    const schema = createRunnerConfigSchema(GenerationCommonFields);

    expect(
      schema.safeParse({
        kind: 'api',
        provider: 'custom-openai-compatible',
        apiBase: 'https://llm.example.test/v1',
        model: 'custom-model',
      }).success,
    ).toBe(false);

    expect(
      schema.safeParse({
        kind: 'api',
        provider: 'custom-openai-compatible',
        service: 'example-llm',
        offering: 'payg',
        apiBase: 'https://llm.example.test/v1',
        model: 'custom-model',
      }).success,
    ).toBe(true);
  });

  it('enforces catalog role admission for API runners while retaining explicit custom providers', () => {
    const plannerSchema = createPlannerConfigSchema(GenerationCommonFields);
    const implementerSchema = createRunnerConfigSchema(GenerationCommonFields);

    for (const provider of ['ollama', 'lm-studio'] as const) {
      const localRunner = {
        kind: 'api' as const,
        provider,
        service: provider,
        offering: 'local' as const,
        apiBase: provider === 'ollama' ? 'http://localhost:11434/v1' : 'http://localhost:1234/v1',
        model: 'local-model',
      };

      expect(plannerSchema.safeParse(localRunner).success).toBe(false);
      expect(implementerSchema.safeParse(localRunner).success).toBe(true);
    }

    const customRunner = {
      kind: 'api' as const,
      provider: 'custom-openai-compatible',
      service: 'example-llm',
      offering: 'payg' as const,
      apiBase: 'https://llm.example.test/v1',
      model: 'custom-model',
    };
    expect(plannerSchema.safeParse(customRunner).success).toBe(true);
    expect(implementerSchema.safeParse(customRunner).success).toBe(true);
  });

  it('rejects partial, unknown, and catalog-mismatched API identities before runner use', () => {
    const schema = createRunnerConfigSchema(GenerationCommonFields);

    expect(
      schema.safeParse({
        kind: 'api',
        provider: 'openrouter',
        service: 'openrouter',
        apiBase: 'https://openrouter.ai/api/v1',
        model: 'anthropic/claude-sonnet-4',
      }).success,
    ).toBe(false);

    const mismatch = schema.safeParse({
      kind: 'api',
      provider: 'openrouter',
      service: 'openrouter',
      offering: 'coding-subscription',
      apiBase: 'https://openrouter.ai/api/v1',
      model: 'anthropic/claude-sonnet-4',
    });
    expect(mismatch.success).toBe(false);
    expect(mismatch.error?.issues[0]?.path).toEqual(['offering']);
    expect(mismatch.error?.issues[0]?.message).toContain('does not match');

    expect(
      schema.safeParse({
        kind: 'api',
        provider: 'openrouter',
        service: 'openrouter',
        offering: 'unknown-offering',
        apiBase: 'https://openrouter.ai/api/v1',
        model: 'anthropic/claude-sonnet-4',
      }).success,
    ).toBe(false);
  });

  it('applies the catalog model policy at both role schema boundaries', () => {
    const implementerSchema = createRunnerConfigSchema(GenerationCommonFields);
    const plannerSchema = createPlannerConfigSchema(GenerationCommonFields);

    for (const tool of [
      'claude-code',
      'codex',
      'opencode',
      'aider',
      'copilot',
      'kilo-code',
    ] as const) {
      for (const schema of [plannerSchema, implementerSchema]) {
        expect(schema.safeParse({ kind: 'cli', tool }).success).toBe(true);
        expect(schema.safeParse({ kind: 'cli', tool, model: 'explicit-model' }).success).toBe(true);
      }
    }

    expect(
      implementerSchema.safeParse({
        kind: 'shell',
        command: './run',
      }).success,
    ).toBe(false);
  });

  it('accepts legacy CLI configs without authChannel but rejects channels unsupported by the tool', () => {
    const schema = createRunnerConfigSchema(GenerationCommonFields);

    expect(schema.safeParse({ kind: 'cli', tool: 'codex' }).success).toBe(true);
    expect(schema.safeParse({ kind: 'cli', tool: 'codex', authChannel: 'session' }).success).toBe(
      true,
    );
    const unsupported = schema.safeParse({
      kind: 'cli',
      tool: 'copilot',
      authChannel: 'api-key',
    });
    expect(unsupported.success).toBe(false);
    expect(unsupported.error?.issues[0]?.path).toEqual(['authChannel']);
  });

  it('schema validation covers every CLI model policy without magic auto data', () => {
    expect(createCliModelPolicySchema('required').safeParse({}).success).toBe(false);
    expect(
      createCliModelPolicySchema('required').safeParse({ model: 'explicit-model' }).success,
    ).toBe(true);

    expect(createCliModelPolicySchema('optional').safeParse({}).success).toBe(true);
    expect(
      createCliModelPolicySchema('optional').safeParse({ model: 'explicit-model' }).success,
    ).toBe(true);

    for (const policy of ['backend-default', 'auto-only'] as const) {
      expect(createCliModelPolicySchema(policy).safeParse({}).success).toBe(true);
      expect(
        createCliModelPolicySchema(policy).safeParse({ model: 'explicit-model' }).success,
      ).toBe(false);
      expect(
        createCliModelPolicySchema(policy).safeParse({ customModels: ['explicit-model'] }).success,
      ).toBe(false);
    }

    expect(createCliModelPolicySchema('auto-only').safeParse({ model: 'auto' }).success).toBe(
      false,
    );
    expect(
      createRunnerConfigSchema(GenerationCommonFields).safeParse({
        kind: 'cli',
        tool: 'copilot',
        model: 'auto',
      }).success,
    ).toBe(false);
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
      service: 'openai',
      offering: 'payg',
      apiBase: 'https://api.openai.com/v1',
      model: 'gpt-5-mini',
      idleWarnMs: 60_000,
      idleKillMs: 300_000,
    });

    expect(result.success).toBe(false);
  });
});

describe('runner trust metadata', () => {
  it('derives every CLI trust lookup from the canonical catalog', () => {
    expect(RUNNER_DESCRIPTORS.cli.trust).toBe(CLI_TOOL_TRUST);

    for (const tool of Object.keys(CLI_TOOL_TRUST) as Array<keyof typeof CLI_TOOL_TRUST>) {
      for (const role of ['planner', 'implementer'] as const) {
        expect(getRunnerTrustMeta(role, { kind: 'cli', tool })).toBe(CLI_TOOL_TRUST[tool][role]);
      }
    }
  });

  it('retains role trust maps for non-CLI runner kinds', () => {
    expect(getRunnerKindMeta('api').trust).toBe(RUNNER_DESCRIPTORS.api.trust);
    expect(getRunnerKindMeta('shell').trust).toBe(RUNNER_DESCRIPTORS.shell.trust);
    expect(getRunnerKindMeta('agent').trust).toBe(RUNNER_DESCRIPTORS.agent.trust);
    expect(getRunnerKindMeta('agent-sdk').trust).toBe(RUNNER_DESCRIPTORS['agent-sdk'].trust);
  });
});
