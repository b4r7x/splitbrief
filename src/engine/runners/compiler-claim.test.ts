import { describe, expect, it } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import type { Config } from '../../core/schemas/config.js';
import { admitCompilerCapability } from './compiler-capability.js';
import { deriveCompilerClaim } from './compiler-claim.js';

const seatbelt = async () => 'seatbelt' as const;
const unavailable = async () => 'unavailable' as const;

function configWithPlanner(planner: Config['planner']): Config {
  return { ...makeConfig(), planner };
}

const SUPPORTED_CLI_CLAIMS = [
  {
    tool: 'opencode',
    transport: 'stdout-final',
    terminalContract: 'opencode-final-message-v1',
    credentialChannel: 'session-copy',
  },
  {
    tool: 'claude-code',
    transport: 'stdout-final',
    terminalContract: 'claude-terminal-result-v1',
    credentialChannel: 'session-copy',
  },
  {
    tool: 'codex',
    transport: 'declared-file',
    terminalContract: 'codex-output-last-message-v1',
    credentialChannel: 'session-copy',
  },
  {
    tool: 'kilo-code',
    transport: 'stdout-final',
    terminalContract: 'kilo-final-message-v1',
    credentialChannel: 'session-copy',
  },
] as const;

describe('deriveCompilerClaim', () => {
  it.each(SUPPORTED_CLI_CLAIMS)(
    'derives the locked $tool claim from the detected runtime version',
    async (expected) => {
      const config = configWithPlanner({ kind: 'cli', tool: expected.tool, model: 'auto' });

      const result = await deriveCompilerClaim({
        config,
        detectedVersion: '2.1.235',
        _containmentProfile: seatbelt,
      });

      expect(result.kind).toBe('derived');
      if (result.kind !== 'derived') return;
      expect(result.claim).toEqual({
        backend: expected.tool,
        version: '2.1.235',
        role: 'planner-read-only',
        transport: expected.transport,
        terminalContract: expected.terminalContract,
        containmentProfile: 'seatbelt',
        credentialChannel: expected.credentialChannel,
        envelopeVersion: 1,
        conformance: {
          roleVector: 'verified',
          terminalProtocol: 'verified',
          containment: 'verified',
          credentialIsolation: 'verified',
          fixtureDate: '2026-08-15',
        },
      });
      expect(result.operationId).toMatch(/^operation-/);
    },
  );

  it('derives for api and agent-sdk kinds', async () => {
    const apiConfig = configWithPlanner({
      kind: 'api',
      provider: 'anthropic',
      service: 'anthropic',
      offering: 'payg',
      apiBase: 'https://api.anthropic.com',
      model: 'claude-3-7-sonnet-latest',
      apiKey: 'test-key',
    });
    const apiResult = await deriveCompilerClaim({ config: apiConfig });
    expect(apiResult.kind).toBe('derived');
    if (apiResult.kind === 'derived') {
      expect(apiResult.claim.backend).toBe('api');
      expect(apiResult.claim.terminalContract).toBe('provider-final-assistant-response-v1');
      expect(apiResult.claim.credentialChannel).toBe('api-key');
      expect(apiResult.claim.version).toBe('');
      expect(apiResult.operationId).toMatch(/^operation-/);
    }

    const agentSdkConfig = configWithPlanner({
      kind: 'agent-sdk',
      model: 'claude-3-7-sonnet-latest',
      apiKey: 'test-key',
    });
    const agentSdkResult = await deriveCompilerClaim({ config: agentSdkConfig });
    expect(agentSdkResult.kind).toBe('derived');
    if (agentSdkResult.kind === 'derived') {
      expect(agentSdkResult.claim.backend).toBe('agent-sdk');
      expect(agentSdkResult.claim.terminalContract).toBe('agent-sdk-final-assistant-turn-v1');
      expect(agentSdkResult.claim.credentialChannel).toBe('api-key');
      expect(agentSdkResult.claim.version).toBe('');
      expect(agentSdkResult.operationId).toMatch(/^operation-/);
    }
  });
});

describe('deriveCompilerClaim — credential channel', () => {
  it('selects the api-key channel when a CLI planner is configured for it', async () => {
    const config = configWithPlanner({
      kind: 'cli',
      tool: 'claude-code',
      model: 'auto',
      authChannel: 'api-key',
    });

    const result = await deriveCompilerClaim({ config, detectedVersion: '2.1.232' });

    expect(result.kind).toBe('derived');
    if (result.kind !== 'derived') return;
    expect(result.claim.credentialChannel).toBe('api-key');
  });

  it('keeps the session-copy channel for a CLI row that admits no api key', async () => {
    const config = configWithPlanner({
      kind: 'cli',
      tool: 'opencode',
      model: 'auto',
      authChannel: 'api-key',
    });

    const result = await deriveCompilerClaim({ config, detectedVersion: '1.18.15' });

    expect(result.kind).toBe('derived');
    if (result.kind !== 'derived') return;
    expect(result.claim.credentialChannel).toBe('session-copy');
  });
});

describe('deriveCompilerClaim — containment observation', () => {
  it('reports containment unverified when the host offers no admitted launcher', async () => {
    const config = configWithPlanner({ kind: 'cli', tool: 'opencode', model: 'auto' });

    const result = await deriveCompilerClaim({
      config,
      detectedVersion: '1.18.15',
      _containmentProfile: unavailable,
    });

    expect(result.kind).toBe('derived');
    if (result.kind !== 'derived') return;
    expect(result.claim.containmentProfile).toBe('unavailable');
    expect(result.claim.conformance.containment).toBe('unverified');
  });

  it('refuses a derived claim on containmentProfile and conformance together, never on conformance alone', async () => {
    const config = configWithPlanner({ kind: 'cli', tool: 'opencode', model: 'auto' });

    const admitted = await deriveCompilerClaim({
      config,
      detectedVersion: '1.18.15',
      _containmentProfile: seatbelt,
    });
    const refused = await deriveCompilerClaim({
      config,
      detectedVersion: '1.18.15',
      _containmentProfile: unavailable,
    });

    expect(admitted.kind).toBe('derived');
    expect(refused.kind).toBe('derived');
    if (admitted.kind !== 'derived' || refused.kind !== 'derived') return;
    expect(admitCompilerCapability(admitted.claim).kind).toBe('admitted');
    const admission = admitCompilerCapability(refused.claim);

    expect(admission.kind).toBe('refused');
    if (admission.kind !== 'refused') return;
    expect(admission.missing).toEqual(['containmentProfile', 'conformance']);
  });
});

describe('deriveCompilerClaim — refusals', () => {
  it('refuses a supported CLI tool with no detected runtime version', async () => {
    const config = configWithPlanner({ kind: 'cli', tool: 'opencode', model: 'auto' });

    const result = await deriveCompilerClaim({ config });

    expect(result.kind).toBe('refused');
    if (result.kind !== 'refused') return;
    expect(result.failure.code).toBe('task_compiler_capability_unsupported');
    expect(result.failure.message).toBe(
      'Compiler capability is not admitted for opencode: version missing or unverified. no verified runtime version evidence.',
    );
  });

  it.each([
    {
      tool: 'copilot',
      message:
        'Compiler capability is not admitted for copilot: backend missing or unverified. no proven non-writing programmatic planner posture in V1.',
    },
    {
      tool: 'aider',
      message:
        'Compiler capability is not admitted for aider: backend missing or unverified. no proven read-only planner contract in V1.',
    },
  ] as const)('refuses the typed-unsupported $tool row', async ({ tool, message }) => {
    const config = configWithPlanner({ kind: 'cli', tool, model: 'auto' });

    const result = await deriveCompilerClaim({ config });

    expect(result.kind).toBe('refused');
    if (result.kind !== 'refused') return;
    expect(result.failure.code).toBe('task_compiler_capability_unsupported');
    expect(result.failure.message).toBe(message);
  });

  it('refuses the legacy shell planner', async () => {
    const config = configWithPlanner({ kind: 'shell', command: 'echo', args: [] });

    const result = await deriveCompilerClaim({ config });

    expect(result.kind).toBe('refused');
    if (result.kind !== 'refused') return;
    expect(result.failure.message).toBe(
      'Compiler capability is not admitted for shell: backend missing or unverified. legacy shell planner lacks compiler containment and final-response conformance.',
    );
  });

  it('refuses the legacy agent planner', async () => {
    const config = configWithPlanner({ kind: 'agent', command: 'echo', args: [] });

    const result = await deriveCompilerClaim({ config });

    expect(result.kind).toBe('refused');
    if (result.kind !== 'refused') return;
    expect(result.failure.message).toBe(
      'Compiler capability is not admitted for agent: backend missing or unverified. legacy agent planner ambient session-file behavior violates exact lease ownership.',
    );
  });
});
