import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { retiredValueNotices, validateConfig } from './config.js';
import { makeConfig } from '#testing/helpers/factories/config.js';

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ['OLLAMA_API_KEY', 'OLLAMA_LOCAL_API_KEY', 'OPENAI_API_KEY']) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('validateConfig', () => {
  it('names a removed API provider at the config path that still uses it', () => {
    const config = {
      ...makeConfig(),
      planner: {
        kind: 'api',
        provider: 'openrouter',
        service: 'openrouter',
        offering: 'payg',
        model: 'm',
        apiBase: 'https://openrouter.ai/api/v1',
      },
    };

    expect(validateConfig(config).errors).toContainEqual({
      path: 'planner.provider',
      message: expect.stringContaining('API provider "openrouter" was removed'),
    });
  });

  it.each(['planner', 'reviewer', 'implementer'])(
    'names the removed agent-sdk runner kind in the %s block',
    (block) => {
      const config = {
        ...makeConfig(),
        [block]: { kind: 'agent-sdk', model: 'claude-sonnet-4-6' },
      };

      const { errors } = validateConfig(config);

      expect(errors).toContainEqual({
        path: `${block}.kind`,
        message: 'Runner kind "agent-sdk" was removed; use kind cli, api, shell, or agent.',
      });
      expect(errors.filter((e) => e.path === `${block}.kind`)).toHaveLength(1);
    },
  );

  it('names the removed agent-sdk runner kind inside an implementer profile', () => {
    const config = {
      ...makeConfig(),
      implementerProfiles: {
        default: 'sdk',
        profiles: { sdk: { kind: 'agent-sdk', model: 'claude-sonnet-4-6' } },
      },
    };

    expect(validateConfig(config).errors).toContainEqual({
      path: 'implementerProfiles.profiles.sdk.kind',
      message: 'Runner kind "agent-sdk" was removed; use kind cli, api, shell, or agent.',
    });
  });

  it('allows local implementers without API credentials', () => {
    delete process.env.OLLAMA_API_KEY;
    const config = makeConfig({
      implementer: {
        kind: 'api',
        provider: 'ollama',
        model: 'm',
        apiBase: 'http://localhost:11434/v1',
      },
    });

    expect(
      validateConfig(config).errors.find((e) => e.path === 'implementer.apiKey'),
    ).toBeUndefined();
  });

  it('rejects local Ollama credentials outside its dedicated environment reference', () => {
    process.env.OLLAMA_API_KEY = 'cloud-key-canary';
    process.env.OLLAMA_LOCAL_API_KEY = 'local-key';

    const localOllama = makeConfig({
      implementer: {
        kind: 'api',
        provider: 'ollama',
        model: 'local-model',
        apiBase: 'http://localhost:11434/v1',
        apiKey: 'env:OLLAMA_LOCAL_API_KEY',
      },
    });

    expect(validateConfig(localOllama).errors).toEqual([]);
    for (const apiKey of ['inline-local-secret', 'env:ARBITRARY_LOCAL_KEY', 'env:OLLAMA_API_KEY']) {
      const rawConfig = {
        ...localOllama,
        implementer: { ...localOllama.implementer, apiKey },
      };
      expect(validateConfig(rawConfig).errors).toContainEqual(
        expect.objectContaining({
          path: 'implementer.apiKey',
          message: expect.stringContaining('OLLAMA_LOCAL_API_KEY'),
        }),
      );
    }
  });

  it('blocks the selected implementer profile when required credentials are missing', () => {
    const config = makeConfig({
      implementerProfiles: {
        default: 'cheap-cloud',
        profiles: {
          'cheap-cloud': {
            kind: 'api',
            provider: 'cheap-gateway',
            model: 'm',
            apiBase: 'https://cheap-gateway.example.test/v1',
          },
          'local-qwen': {
            kind: 'api',
            provider: 'ollama',
            model: 'qwen2.5-coder:7b',
            apiBase: 'http://localhost:11434/v1',
          },
        },
      },
    });

    const { errors, warnings } = validateConfig(config);

    expect(
      errors.find((e) => e.path === 'implementerProfiles.profiles.cheap-cloud.apiKey'),
    ).toBeTruthy();
    expect(
      warnings.some((w) =>
        w.includes('Default implementer profile cheap-cloud is missing credentials'),
      ),
    ).toBe(false);
  });

  it.each(['instant', 'quick', 'standard', 'speckit', 'anything'])(
    'loads a config naming the retired workflow.mode %s with exactly one notice',
    (mode) => {
      const base = makeConfig();
      const config = { ...base, workflow: { ...base.workflow, mode } };

      const { errors } = validateConfig(config);
      const warnings = retiredValueNotices(config);

      expect(errors).toEqual([]);
      expect(warnings.filter((w) => w.includes('mode'))).toEqual([
        'workflow.mode was retired and is ignored: every run plans in one session. Delete workflow.mode.',
      ]);
    },
  );

  it('loads approve: all with mode: speckit with exactly one notice per key', () => {
    const base = makeConfig();
    const config = { ...base, workflow: { ...base.workflow, approve: 'all', mode: 'speckit' } };

    const { errors, data } = validateConfig(config);
    const warnings = retiredValueNotices(config);

    expect(errors).toEqual([]);
    expect(data?.workflow.approve).toBe('plan');
    expect(warnings.filter((w) => w.includes('was retired'))).toEqual([
      'workflow.mode was retired and is ignored: every run plans in one session. Delete workflow.mode.',
      'workflow.approve "all" was retired; using "plan": the plan waits for your approval before the build. Set approve to plan or none.',
    ]);
  });

  it.each([
    [
      'approval.enabled',
      { approval: { enabled: false }, workflow: {} },
      'approval.enabled was retired and is ignored: a write to a protected path always asks, and no other write does. Delete approval.enabled.',
    ],
    [
      'workflow.drift_chain_threshold',
      { approval: {}, workflow: { driftChainThreshold: 0.4 } },
      'workflow.drift_chain_threshold was retired and is ignored: SPLITBRIEF no longer scores drift chains; the reviewer reads the files a brief touched but did not suggest. Delete workflow.drift_chain_threshold.',
    ],
  ])('loads the retired %s with exactly one notice', (_key, retired, notice) => {
    const base = makeConfig();
    const config = {
      ...base,
      approval: { ...base.approval, ...retired.approval },
      workflow: { ...base.workflow, ...retired.workflow },
    };

    expect(validateConfig(config).errors).toEqual([]);
    expect(retiredValueNotices(config)).toEqual([notice]);
  });

  it.each([
    ['typecheck', 'typecheck', true],
    ['lint', 'lint', false],
    ['test', 'test', true],
    ['typecheckCommand', 'typecheck_command', 'npx tsc --noEmit'],
    ['lintCommand', 'lint_command', 'npx biome check .'],
  ] as const)('loads the retired validation.%s with exactly one notice', (key, name, value) => {
    const base = makeConfig();
    const config = { ...base, validation: { ...base.validation, [key]: value } };

    const { errors, data } = validateConfig(config);

    expect(errors).toEqual([]);
    expect(data?.validation.endChecks).toBeUndefined();
    expect(retiredValueNotices(config)).toEqual([
      `validation.${name} was retired and is ignored: the reviewer chooses the commands that verify the change, and validation.end_checks turns them on or off. Delete validation.${name}.`,
    ]);
  });

  it('gives no retired notice for validation.end_checks', () => {
    const base = makeConfig();
    const config = { ...base, validation: { ...base.validation, endChecks: false } };

    expect(validateConfig(config).errors).toEqual([]);
    expect(retiredValueNotices(config)).toEqual([]);
  });

  it('loads a retired approval.enabled: true with exactly one notice', () => {
    const config = { ...makeConfig(), approval: { enabled: true } };

    const { errors } = validateConfig(config);
    const warnings = retiredValueNotices(config);

    expect(errors).toEqual([]);
    expect(warnings.filter((w) => w.includes('approval.enabled'))).toEqual([
      'approval.enabled was retired and is ignored: a write to a protected path always asks, and no other write does. Delete approval.enabled.',
    ]);
  });

  it.each(['all', 'spec', 'default'])(
    'loads the retired approve level %s as plan with one notice',
    (approve) => {
      const base = makeConfig();
      const config = { ...base, workflow: { ...base.workflow, approve } };

      const { errors, data } = validateConfig(config);
      const warnings = retiredValueNotices(config);

      expect(errors).toEqual([]);
      expect(data?.workflow.approve).toBe('plan');
      expect(warnings.filter((w) => w.includes('workflow.approve'))).toEqual([
        `workflow.approve "${approve}" was retired; using "plan": the plan waits for your approval before the build. Set approve to plan or none.`,
      ]);
    },
  );

  it.each(['plan', 'none', undefined])('gives no approve notice for approve %s', (approve) => {
    const base = makeConfig();
    const config = { ...base, workflow: { ...base.workflow, approve } };

    const { errors, data } = validateConfig(config);
    const warnings = retiredValueNotices(config);

    expect(errors).toEqual([]);
    expect(data?.workflow.approve).toBe(approve);
    expect(warnings.filter((w) => w.includes('approve'))).toEqual([]);
  });

  it('loads a retired approval.tiers map with exactly one notice', () => {
    const config = makeConfig({
      approval: {
        feedRejectionsToPlanner: true,
        tiers: {
          destructive: 'auto',
          package_change: 'auto',
          write_out_of_scope: 'sticky',
        },
      },
    });

    const { errors } = validateConfig(config);
    const warnings = retiredValueNotices(config);

    expect(errors).toEqual([]);
    expect(warnings.filter((w) => w.includes('approval.tiers'))).toEqual([
      'approval.tiers was retired and is ignored: a write to a protected path always asks, and no other write does. Delete approval.tiers.',
    ]);
  });

  it.each([
    {
      key: 'taskReview',
      value: 'every',
      notice:
        'workflow.task_review was retired and is ignored: the build no longer stops for your review after each brief. Delete workflow.task_review.',
    },
    {
      key: 'briefReview',
      value: 'rich',
      notice:
        'workflow.brief_review was retired and is ignored: you review the briefs on the plan card. Delete workflow.brief_review.',
    },
    {
      key: 'speckit',
      value: { minCoverage: 0.8 },
      notice:
        'workflow.speckit was retired and is ignored: every run plans in one session. Delete workflow.speckit.',
    },
  ])('loads a retired workflow.$key with exactly one notice', ({ key, value, notice }) => {
    const base = makeConfig();
    const config = { ...base, workflow: { ...base.workflow, [key]: value } };

    const { errors } = validateConfig(config);
    const warnings = retiredValueNotices(config);

    expect(errors).toEqual([]);
    expect(warnings).toEqual([notice]);
  });

  it('blocks non-default implementer profiles when required credentials are missing', () => {
    const config = makeConfig({
      implementerProfiles: {
        default: 'local-qwen',
        profiles: {
          'cheap-cloud': {
            kind: 'api',
            provider: 'cheap-gateway',
            model: 'm',
            apiBase: 'https://cheap-gateway.example.test/v1',
          },
          'local-qwen': {
            kind: 'api',
            provider: 'ollama',
            model: 'qwen2.5-coder:7b',
            apiBase: 'http://localhost:11434/v1',
          },
        },
      },
    });

    const { errors, warnings } = validateConfig(config);

    expect(
      errors.find((e) => e.path === 'implementerProfiles.profiles.cheap-cloud.apiKey'),
    ).toBeTruthy();
    expect(
      warnings.some((w) =>
        w.includes('Non-default implementer profile cheap-cloud is missing credentials'),
      ),
    ).toBe(false);
  });

  it('loads a retired escalation block with exactly one notice', () => {
    const config = makeConfig({
      escalation: {
        intermediateProvider: 'ollama',
        intermediateModel: 'qwen2.5-coder:7b',
        enabled: true,
      },
    });

    const { errors } = validateConfig(config);
    const warnings = retiredValueNotices(config);

    expect(errors).toEqual([]);
    expect(warnings.filter((w) => w.includes('escalation'))).toEqual([
      "escalation was retired and is ignored: the planner's consult replaces the intermediate tier. Delete escalation.",
    ]);
  });

  it.each([0, 3, 99])(
    'loads a retired workflow.max_retries %i with exactly one notice',
    (maxRetries) => {
      const base = makeConfig();
      const config = { ...base, workflow: { ...base.workflow, maxRetries } };

      const { errors } = validateConfig(config);
      const warnings = retiredValueNotices(config);

      expect(errors).toEqual([]);
      expect(warnings.filter((w) => w.includes('max_retries'))).toEqual([
        'workflow.max_retries was retired and is ignored: the lineage attempt allowance bounds the ladder now. Delete workflow.max_retries.',
      ]);
    },
  );

  it('requires explicit credentials for custom remote providers', () => {
    const config = makeConfig({
      implementer: {
        kind: 'api',
        provider: 'custom-ollama',
        model: 'some-model',
        apiBase: 'http://my-server:11434/v1',
      },
    });

    expect(
      validateConfig(config).errors.find((e) => e.path === 'implementer.apiKey'),
    ).toMatchObject({
      message: 'Custom provider custom-ollama implementer requires implementer.apiKey',
    });

    const withKey = makeConfig({
      implementer: {
        kind: 'api',
        provider: 'custom-ollama',
        model: 'some-model',
        apiBase: 'http://my-server:11434/v1',
        apiKey: 'custom-key',
      },
    });
    expect(
      validateConfig(withKey).errors.find((e) => e.path === 'implementer.apiKey'),
    ).toBeUndefined();
  });

  it('rejects unknown planner provider env apiKey references with arbitrary apiBase', () => {
    process.env.OPENAI_API_KEY = 'sk-test-env';
    const config = makeConfig({
      planner: {
        kind: 'api',
        provider: 'custom-planner',
        model: 'm',
        apiBase: 'https://custom-planner.example.com/v1',
        apiKey: 'env:OPENAI_API_KEY',
      },
    });

    expect(validateConfig(config).errors).toContainEqual({
      path: 'planner.apiKey',
      message: expect.stringMatching(
        /custom\/unknown provider.*env apiKey reference.*apiBase.*exfiltration risk/i,
      ),
    });
  });

  it('rejects unknown implementer profile env apiKey references with arbitrary apiBase', () => {
    process.env.OPENAI_API_KEY = 'sk-test-env';
    const config = makeConfig({
      implementerProfiles: {
        default: 'custom-remote',
        profiles: {
          'custom-remote': {
            kind: 'api',
            provider: 'custom-implementer',
            model: 'm',
            apiBase: 'https://custom-implementer.example.com/v1',
            apiKey: 'env:OPENAI_API_KEY',
          },
        },
      },
    });

    expect(validateConfig(config).errors).toContainEqual({
      path: 'implementerProfiles.profiles.custom-remote.apiKey',
      message: expect.stringMatching(
        /custom\/unknown provider.*env apiKey reference.*apiBase.*exfiltration risk/i,
      ),
    });
  });

  it('allows known provider env apiKey references with official same-origin apiBase', () => {
    process.env.OLLAMA_LOCAL_API_KEY = 'local-key';
    const config = makeConfig({
      implementer: {
        kind: 'api',
        provider: 'ollama',
        model: 'qwen2.5-coder:7b',
        apiBase: 'http://localhost:11434/v1',
        apiKey: 'env:OLLAMA_LOCAL_API_KEY',
      },
    });

    expect(
      validateConfig(config).errors.find((e) => e.path === 'implementer.apiKey'),
    ).toBeUndefined();
  });

  it('keeps userinfo credentials out of the custom-endpoint exfiltration error', () => {
    process.env.OPENAI_API_KEY = 'sk-test-env';
    const config = makeConfig({
      planner: {
        kind: 'api',
        provider: 'custom-planner',
        model: 'm',
        apiBase: 'https://alice:secret@proxy.example.com/v1',
        apiKey: 'env:OPENAI_API_KEY',
      },
    });

    const message = validateConfig(config).errors.find((e) => e.path === 'planner.apiKey')?.message;

    expect(message).toMatch(/exfiltration risk/);
    expect(message).not.toContain('alice');
    expect(message).not.toContain('secret');
  });

  it('rejects planner apiBase URLs with embedded credentials without leaking them in errors', () => {
    const config = makeConfig({
      planner: {
        kind: 'api',
        provider: 'custom-gateway',
        model: 'm',
        apiKey: 'configured-key',
        apiBase: 'https://alice:secret@example.com/v1',
      },
    });

    const { errors } = validateConfig(config);

    expect(errors).toEqual([
      {
        path: 'planner.apiBase',
        message: 'Invalid apiBase: must not include credentials',
        diagnosticState: 'endpoint-invalid',
      },
    ]);
    expect(JSON.stringify(errors)).not.toContain('alice');
    expect(JSON.stringify(errors)).not.toContain('secret');
  });

  it('rejects reviewer apiBase URLs with embedded credentials without leaking them in errors', () => {
    const config = makeConfig({
      reviewer: {
        kind: 'api',
        provider: 'custom-gateway',
        model: 'm',
        apiKey: 'configured-key',
        apiBase: 'https://alice:secret@example.com/v1',
      },
    });

    const { errors } = validateConfig(config);

    expect(errors).toEqual([
      {
        path: 'reviewer.apiBase',
        message: 'Invalid apiBase: must not include credentials',
        diagnosticState: 'endpoint-invalid',
      },
    ]);
    expect(JSON.stringify(errors)).not.toContain('alice');
    expect(JSON.stringify(errors)).not.toContain('secret');
  });

  it('names the reviewer seat in its credential error instead of the planner', () => {
    const config = makeConfig({
      reviewer: {
        kind: 'api',
        provider: 'custom-gateway',
        model: 'm',
        apiBase: 'https://api.example.com',
      },
    });

    const { errors } = validateConfig(config);

    const reviewerError = errors.find((error) => error.path === 'reviewer.apiKey');
    expect(reviewerError?.message).toContain('reviewer');
    expect(reviewerError?.message).not.toContain('planner');
  });

  it('reports nothing extra for a config without a reviewer block', () => {
    expect(validateConfig(makeConfig())).toEqual({
      errors: [],
      warnings: [],
      data: expect.anything(),
    });
  });

  it.each([
    { key: 'autoApproveSpec', value: true },
    { key: 'autoApprovePlan', value: true },
    { key: 'commitStrategy', value: 'per-task' },
  ])('reports the removed workflow.$key field at its own path', ({ key, value }) => {
    const config = makeConfig();

    const { errors, data } = validateConfig({
      ...config,
      workflow: { ...config.workflow, [key]: value },
    });

    expect(errors).toContainEqual({
      path: `workflow.${key}`,
      message: expect.stringContaining('Unknown config key'),
    });
    expect(data).toBeUndefined();
  });

  it('rejects the removed sessions.scope global value', () => {
    const { errors, data } = validateConfig({ ...makeConfig(), sessions: { scope: 'global' } });

    expect(errors.some(({ path }) => path === 'sessions.scope')).toBe(true);
    expect(data).toBeUndefined();
  });

  it('compiler key is rejected with the retirement message', () => {
    const { errors } = validateConfig({
      ...makeConfig(),
      compiler: { kind: 'cli', tool: 'codex' },
    });

    expect(errors).toContainEqual({
      path: 'compiler',
      message:
        'Unknown key "compiler" \u2014 the brief compiler was retired on 2026-09-13; briefs compile from the plan directly.',
    });
  });

  it('outputFormat on a structured-terminal tool is refused at load', () => {
    const config = makeConfig({
      planner: { kind: 'cli', tool: 'claude-code', outputFormat: 'text' },
    });

    expect(validateConfig(config).errors).toContainEqual({
      path: 'planner.outputFormat',
      message:
        "Configured outputFormat cannot replace the claude-code terminal contract; the backend's native parser and terminal protocol stay authoritative.",
    });
    expect(
      validateConfig(
        makeConfig({ planner: { kind: 'cli', tool: 'opencode', outputFormat: 'text' } }),
      ).errors,
    ).toEqual([]);
  });

  it('rejects {prompt} in command strings', () => {
    const result = validateConfig({
      ...makeConfig(),
      implementer: {
        kind: 'agent',
        command: './agent-{prompt}',
        model: 'agent-default',
      },
    });

    expect(result.errors).toContainEqual({
      path: 'implementer.command',
      message: expect.stringContaining('must not contain {prompt}'),
    });
  });
});
