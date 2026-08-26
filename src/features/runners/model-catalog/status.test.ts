import { describe, expect, it } from 'vitest';
import { cliDetectionFor } from '#testing/helpers/factories/detection.js';
import type { CliProviderAuthFact, CliToolDetection } from '../../../core/discovery/detection.js';
import { CLI_TOOL_CATALOG } from '../../../core/runners/cli-tool-catalog.js';
import { deriveCliStatus, type PickerDetectionSnapshot } from './status.js';

const KILO_FACTS: readonly CliProviderAuthFact[] = [
  { provider: 'GitHub Copilot', source: 'oauth' },
  { provider: 'Alibaba Coding Plan', source: 'api' },
  { provider: 'OpenAI', source: 'env', envVar: 'OPENAI_API_KEY' },
];

function snapshot(detection: CliToolDetection): PickerDetectionSnapshot {
  return { cliTools: [detection], providers: [] };
}

describe('deriveCliStatus with per-provider facts', () => {
  it('resolves ready with the configured provider names when the listing has entries', () => {
    const detection = cliDetectionFor('ready', 'kilo-code', {
      providerAuth: { kind: 'read', facts: KILO_FACTS },
    });

    const status = deriveCliStatus(CLI_TOOL_CATALOG['kilo-code'], snapshot(detection));

    expect(status).toEqual({
      state: 'ready',
      remediation: null,
      configuredProviders: ['GitHub Copilot', 'Alibaba Coding Plan', 'OpenAI'],
    });
  });

  it('lists a provider once when it is stored and also recognized via an env var', () => {
    const detection = cliDetectionFor('ready', 'opencode', {
      providerAuth: {
        kind: 'read',
        facts: [
          { provider: 'OpenAI', source: 'oauth' },
          { provider: 'OpenCode Go', source: 'api' },
          { provider: 'Kimi For Coding', source: 'env', envVar: 'KIMI_API_KEY' },
          { provider: 'Ollama Cloud', source: 'env', envVar: 'OLLAMA_API_KEY' },
          { provider: 'OpenAI', source: 'env', envVar: 'OPENAI_API_KEY' },
        ],
      },
    });

    const status = deriveCliStatus(CLI_TOOL_CATALOG.opencode, snapshot(detection));

    expect(status).toEqual({
      state: 'ready',
      remediation: null,
      configuredProviders: ['OpenAI', 'OpenCode Go', 'Kimi For Coding', 'Ollama Cloud'],
    });
  });

  it('lets a non-empty listing outrank a stale presence-derived auth diagnostic', () => {
    const detection = cliDetectionFor('unauthenticated', 'kilo-code', {
      providerAuth: { kind: 'read', facts: [{ provider: 'GitHub Copilot', source: 'oauth' }] },
    });

    const status = deriveCliStatus(CLI_TOOL_CATALOG['kilo-code'], snapshot(detection));

    expect(status).toEqual({
      state: 'ready',
      remediation: null,
      configuredProviders: ['GitHub Copilot'],
    });
  });

  it('resolves a truthful zero-provider listing as unauthenticated with sign-in remediation', () => {
    const detection = cliDetectionFor('unauthenticated', 'kilo-code', {
      providerAuth: { kind: 'empty' },
    });

    const status = deriveCliStatus(CLI_TOOL_CATALOG['kilo-code'], snapshot(detection));

    expect(status).toEqual({
      state: 'unauthenticated',
      remediation: 'Sign in or configure a provider - free models require sign-in.',
    });
  });

  it('keeps the presence-derived remediation when no facts exist (legacy cache)', () => {
    const detection = cliDetectionFor('unauthenticated', 'kilo-code');

    const status = deriveCliStatus(CLI_TOOL_CATALOG['kilo-code'], snapshot(detection));

    expect(status).toEqual({
      state: 'unauthenticated',
      remediation: detection.diagnostic.remediation,
    });
  });

  it('keeps presence-derived readiness bare when no facts exist (oracle fallback)', () => {
    const detection = cliDetectionFor('ready', 'opencode');

    const status = deriveCliStatus(CLI_TOOL_CATALOG.opencode, snapshot(detection));

    expect(status).toEqual({ state: 'ready', remediation: null });
  });

  it('never upgrades a non-auth blocker, even with a non-empty listing', () => {
    const detection = cliDetectionFor('incompatible', 'kilo-code', {
      providerAuth: { kind: 'read', facts: [{ provider: 'GitHub Copilot', source: 'oauth' }] },
    });

    const status = deriveCliStatus(CLI_TOOL_CATALOG['kilo-code'], snapshot(detection));

    expect(status).toEqual({
      state: 'incompatible',
      remediation: detection.diagnostic.remediation,
    });
  });
});
