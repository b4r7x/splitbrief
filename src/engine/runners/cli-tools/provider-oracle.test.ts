import { describe, expect, it } from 'vitest';
import type { CliProbeCommand } from './contract.js';
import {
  isProviderOracleProbe,
  parseProviderOracleOutput,
  providerOracleAuthFact,
  providerOracleCommand,
} from './provider-oracle.js';

// Captured verbatim from `kilo auth list` (Kilo Code CLI) on 2026-08-03.
const KILO_AUTH_LIST_OUTPUT =
  '┌  Credentials \u001b[90m~/.local/share/kilo/auth.json\n│\n●  GitHub Copilot \u001b[90moauth\n│\n●  Alibaba Coding Plan \u001b[90mapi\n│\n└  2 credentials\n\n┌  Environment\n│\n●  Kimi For Coding \u001b[90mKIMI_API_KEY\n│\n●  Ollama Cloud \u001b[90mOLLAMA_API_KEY\n│\n●  OpenAI \u001b[90mOPENAI_API_KEY\n│\n└  3 environment variables\n\n';

// Captured verbatim from `opencode providers list` on 2026-08-03.
const OPENCODE_PROVIDERS_LIST_OUTPUT =
  '┌  Credentials \u001b[90m~/.local/share/opencode/auth.json\n│\n●  OpenAI \u001b[90moauth\n│\n●  OpenCode Go \u001b[90mapi\n│\n└  2 credentials\n\n┌  Environment\n│\n●  Kimi For Coding \u001b[90mKIMI_API_KEY\n│\n●  Ollama Cloud \u001b[90mOLLAMA_API_KEY\n│\n●  OpenAI \u001b[90mOPENAI_API_KEY\n│\n└  3 environment variables\n\n';

const KILO_ENTRIES = [
  { provider: 'GitHub Copilot', source: 'oauth' },
  { provider: 'Alibaba Coding Plan', source: 'api' },
  { provider: 'Kimi For Coding', source: 'env', envVar: 'KIMI_API_KEY' },
  { provider: 'Ollama Cloud', source: 'env', envVar: 'OLLAMA_API_KEY' },
  { provider: 'OpenAI', source: 'env', envVar: 'OPENAI_API_KEY' },
] as const;

function probeCommand(command: readonly [string, ...string[]]): CliProbeCommand {
  return { command, cwd: 'neutral', timeoutMs: 1_000, maxOutputBytes: 1_024 };
}

describe('provider oracle parser', () => {
  it('parses the real kilo auth list output into names and source kinds only', () => {
    expect(parseProviderOracleOutput(KILO_AUTH_LIST_OUTPUT)).toEqual({
      kind: 'success',
      entries: KILO_ENTRIES,
    });
  });

  it('parses the real opencode providers list output', () => {
    expect(parseProviderOracleOutput(OPENCODE_PROVIDERS_LIST_OUTPUT)).toEqual({
      kind: 'success',
      entries: [
        { provider: 'OpenAI', source: 'oauth' },
        { provider: 'OpenCode Go', source: 'api' },
        { provider: 'Kimi For Coding', source: 'env', envVar: 'KIMI_API_KEY' },
        { provider: 'Ollama Cloud', source: 'env', envVar: 'OLLAMA_API_KEY' },
        { provider: 'OpenAI', source: 'env', envVar: 'OPENAI_API_KEY' },
      ],
    });
  });

  it('tolerates section reordering, ASCII glyphs, and missing footers', () => {
    const reordered = [
      '| Environment',
      '* Ollama Cloud OLLAMA_API_KEY',
      '| Credentials ~/.local/share/kilo/auth.json',
      '* GitHub Copilot oauth',
      '',
    ].join('\n');

    expect(parseProviderOracleOutput(reordered)).toEqual({
      kind: 'success',
      entries: [
        { provider: 'Ollama Cloud', source: 'env', envVar: 'OLLAMA_API_KEY' },
        { provider: 'GitHub Copilot', source: 'oauth' },
      ],
    });
  });

  it('reports a clean zero-credential listing as an empty success, not a failure', () => {
    expect(
      parseProviderOracleOutput(
        '┌  Credentials ~/.local/share/kilo/auth.json\n│\n└  0 credentials\n',
      ),
    ).toEqual({ kind: 'success', entries: [] });
  });

  it.each([
    ['plain error text', 'kilo: unknown command "auth"'],
    ['empty output', ''],
    ['json output', '{"credentials":[{"provider":"OpenAI","apiKey":"sk-secret"}]}'],
    [
      'entry before any section header',
      '●  GitHub Copilot oauth\n┌  Credentials\n└  1 credentials',
    ],
    ['unknown credential source kind', '┌  Credentials\n●  OpenAI wellknown\n└  1 credentials'],
    [
      'credential count mismatch after truncation',
      '┌  Credentials\n●  GitHub Copilot oauth\n└  2 credentials',
    ],
    [
      'environment count mismatch',
      '┌  Environment\n●  OpenAI OPENAI_API_KEY\n└  3 environment variables',
    ],
    [
      'environment entry without an env var name',
      '┌  Environment\n●  OpenAI something-lowercase\n└  1 environment variables',
    ],
  ])('resolves %s to a parse failure instead of throwing', (_name, output) => {
    expect(parseProviderOracleOutput(output)).toEqual({ kind: 'parse-failure' });
  });

  it('never captures credential values, only display names and env var names', () => {
    const parsed = parseProviderOracleOutput(KILO_AUTH_LIST_OUTPUT);
    expect(parsed.kind).toBe('success');
    if (parsed.kind !== 'success') return;
    for (const entry of parsed.entries) {
      expect(Object.keys(entry).sort()).toEqual(
        entry.source === 'env' ? ['envVar', 'provider', 'source'] : ['provider', 'source'],
      );
    }
  });
});

describe('providerOracleAuthFact', () => {
  const output = (stdout: string) => ({
    stdout,
    stderr: '',
    exitCode: 0,
    timedOut: false,
    outputExceeded: false,
  });

  it('maps at least one listed entry to verified', () => {
    expect(providerOracleAuthFact(output(OPENCODE_PROVIDERS_LIST_OUTPUT))).toBe('verified');
  });

  it('maps a clean zero listing to missing', () => {
    expect(providerOracleAuthFact(output('┌  Credentials\n└  0 credentials\n'))).toBe('missing');
  });

  it('maps unparseable output to malformed', () => {
    expect(providerOracleAuthFact(output('segmentation fault'))).toBe('malformed');
  });
});

describe('provider oracle probe identity', () => {
  it('declares the documented read-only listing argv for both forks', () => {
    expect(providerOracleCommand('opencode')).toEqual(['opencode', 'providers', 'list']);
    expect(providerOracleCommand('kilo-code')).toEqual(['kilo', 'auth', 'list']);
    expect(providerOracleCommand('codex')).toBeUndefined();
  });

  it('matches only the exact declared argv', () => {
    expect(
      isProviderOracleProbe({
        tool: 'kilo-code',
        command: probeCommand(['kilo', 'auth', 'list']),
      }),
    ).toBe(true);
    expect(
      isProviderOracleProbe({
        tool: 'opencode',
        command: probeCommand(['opencode', 'providers', 'list']),
      }),
    ).toBe(true);
    expect(
      isProviderOracleProbe({
        tool: 'kilo-code',
        command: probeCommand(['kilo', 'auth', 'list', '--json']),
      }),
    ).toBe(false);
    expect(
      isProviderOracleProbe({
        tool: 'codex',
        command: probeCommand(['kilo', 'auth', 'list']),
      }),
    ).toBe(false);
  });
});
