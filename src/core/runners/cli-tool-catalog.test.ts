import { describe, expect, it } from 'vitest';
import {
  CLI_TOOL_CATALOG,
  CLI_TOOL_IDS,
  CLI_TOOL_TRUST,
  IMPLEMENTER_CLI_TOOL_IDS,
  PLANNER_CLI_TOOL_IDS,
  cliModelPolicyViolations,
  cliToolSupportsRole,
  selectCliAuthChannel,
  type CliModelPolicy,
} from './cli-tool-catalog.js';

const CURRENT_CLI_TOOL_IDS = [
  'claude-code',
  'codex',
  'opencode',
  'aider',
  'copilot',
  'kilo-code',
] as const;

describe('CLI tool catalog', () => {
  it('describes the six current tools for both runner roles', () => {
    expect(Object.keys(CLI_TOOL_CATALOG)).toEqual(CURRENT_CLI_TOOL_IDS);
    expect(Object.keys(CLI_TOOL_TRUST)).toEqual(CURRENT_CLI_TOOL_IDS);
    expect(CLI_TOOL_IDS).toEqual(CURRENT_CLI_TOOL_IDS);
    expect(PLANNER_CLI_TOOL_IDS).toEqual(
      CLI_TOOL_IDS.filter((id) => CLI_TOOL_CATALOG[id].roles.includes('planner')),
    );
    expect(IMPLEMENTER_CLI_TOOL_IDS).toEqual(
      CLI_TOOL_IDS.filter((id) => CLI_TOOL_CATALOG[id].roles.includes('implementer')),
    );

    for (const id of CURRENT_CLI_TOOL_IDS) {
      const descriptor = CLI_TOOL_CATALOG[id];

      expect(descriptor.id).toBe(id);
      expect(descriptor.roles).toEqual(['planner', 'implementer']);
      expect(descriptor.modelPolicy).toEqual({ planner: 'optional', implementer: 'optional' });
      expect(cliToolSupportsRole(id, 'planner')).toBe(true);
      expect(cliToolSupportsRole(id, 'implementer')).toBe(true);
      expect(descriptor.shell).toEqual({ planner: true, implementer: true });
      expect(descriptor.network).toEqual({ planner: true, implementer: true });
      expect(descriptor.directWrite).toEqual({ planner: false, implementer: true });
      expect(descriptor.compatibility.installUrl).toMatch(/^https:\/\//);
      expect(descriptor.compatibility.testedVersion).toMatch(/^\d+\.\d+\.\d+$/);
      expect(descriptor.compatibility.evidence.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('isolates catalog descriptors from mutation', () => {
    const descriptor = CLI_TOOL_CATALOG.codex;

    expect(Reflect.set(descriptor, 'displayName', 'Changed')).toBe(false);
    expect(Reflect.set(descriptor.roles, 0, 'implementer')).toBe(false);
    expect(Reflect.set(descriptor.modelPolicy, 'planner', 'required')).toBe(false);
    expect(Reflect.set(descriptor.auth.env, 0, 'CHANGED')).toBe(false);
    expect(Reflect.set(descriptor.auth.channels, 0, descriptor.auth.channels[1])).toBe(false);
    expect(Reflect.set(descriptor.auth.channels[0]?.env ?? [], 0, 'CHANGED')).toBe(false);
    expect(Reflect.set(descriptor.compatibility.evidence, 'asOf', '1900-01-01')).toBe(false);
    expect(Reflect.set(CLI_TOOL_TRUST.codex.implementer.autoAllowFlags, 0, '--changed')).toBe(
      false,
    );

    expect(CLI_TOOL_CATALOG.codex.displayName).toBe('OpenAI Codex CLI');
    expect(CLI_TOOL_CATALOG.codex.roles).toEqual(['planner', 'implementer']);
    expect(CLI_TOOL_CATALOG.codex.modelPolicy.planner).toBe('optional');
    expect(CLI_TOOL_CATALOG.codex.auth.env).toEqual([]);
    expect(CLI_TOOL_CATALOG.codex.compatibility.evidence.asOf).not.toBe('1900-01-01');
    expect(CLI_TOOL_TRUST.codex.implementer.autoAllowFlags).toEqual(['--sandbox workspace-write']);
  });

  it('enforces required, optional, backend-default, and auto-only model policies', () => {
    const policies = {
      required: {
        missing: ['model'],
        concrete: [],
        custom: ['model'],
      },
      optional: {
        missing: [],
        concrete: [],
        custom: [],
      },
      'backend-default': {
        missing: [],
        concrete: ['model'],
        custom: ['customModels'],
      },
      'auto-only': {
        missing: [],
        concrete: ['model'],
        custom: ['customModels'],
      },
    } as const satisfies Record<
      CliModelPolicy,
      { missing: readonly string[]; concrete: readonly string[]; custom: readonly string[] }
    >;

    for (const [policy, expected] of Object.entries(policies) as Array<
      [CliModelPolicy, (typeof policies)[CliModelPolicy]]
    >) {
      expect(cliModelPolicyViolations(policy, {}).map(({ field }) => field)).toEqual(
        expected.missing,
      );
      expect(
        cliModelPolicyViolations(policy, { model: 'fixture-model' }).map(({ field }) => field),
      ).toEqual(expected.concrete);
      expect(
        cliModelPolicyViolations(policy, { customModels: ['fixture-model'] }).map(
          ({ field }) => field,
        ),
      ).toEqual(expected.custom);
    }

    for (const policy of Object.keys(policies) as CliModelPolicy[]) {
      expect(cliModelPolicyViolations(policy, { model: 'auto' })).toEqual([
        {
          field: 'model',
          message: 'model "auto" is not a model ID; omit model to use automatic selection',
        },
      ]);
    }
  });

  it('selects auth and billing as one explicit channel', () => {
    expect(selectCliAuthChannel('codex', { channel: 'session' })).toEqual({
      id: 'session',
      env: [],
      stateBridge: 'host-cli-state',
      billing: 'subscription-included',
    });
    expect(selectCliAuthChannel('codex', { channel: 'api-key' })).toEqual({
      id: 'api-key',
      env: ['OPENAI_API_KEY'],
      stateBridge: 'none',
      billing: 'api-metered',
    });
    expect(selectCliAuthChannel('codex', undefined)).toBeUndefined();
    expect(selectCliAuthChannel('copilot', { channel: 'api-key' })).toBeUndefined();
    expect(CLI_TOOL_CATALOG['claude-code'].auth.env).toEqual([]);
    expect(CLI_TOOL_CATALOG.codex.auth.env).toEqual([]);
    expect(CLI_TOOL_CATALOG.copilot.auth.env).toEqual(['GH_TOKEN', 'GITHUB_TOKEN']);
  });
});
