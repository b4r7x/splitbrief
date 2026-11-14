import { afterEach, describe, expect, it } from 'vitest';
import { readyFacts } from '#testing/helpers/factories/cli-readiness.js';
import { CliReadinessResultSchema } from '../schemas/readiness.js';
import { cliReadinessRemediation, deriveCliReadiness } from './cli-remediation.js';

describe('CLI runner readiness', () => {
  const hostPlatform = process.platform;
  const setPlatform = (value: NodeJS.Platform): void => {
    Object.defineProperty(process, 'platform', { value, configurable: true });
  };
  afterEach(() => setPlatform(hostPlatform));

  it.each([
    [
      'darwin',
      'SPLITBRIEF looks for the Claude Code CLI session in the macOS keychain. Sign in to Claude Code CLI, then run `splitbrief doctor` again.',
    ],
    [
      'linux',
      'SPLITBRIEF looks for the Claude Code CLI session in its session files. Sign in to Claude Code CLI, then run `splitbrief doctor` again.',
    ],
  ] as const)(
    'on %s says where it looked for the session and gives the sign-in action',
    (platform, remediation) => {
      setPlatform(platform);
      expect(
        deriveCliReadiness(
          readyFacts({
            tool: 'claude-code',
            auth: 'unauthenticated',
          }),
        ).remediation,
      ).toBe(remediation);
    },
  );

  const keychain = (name: string) =>
    `SPLITBRIEF looks for the ${name} session in the macOS keychain. Sign in to ${name}, then run \`splitbrief doctor\` again.`;
  const sessionFiles = (name: string) =>
    `SPLITBRIEF looks for the ${name} session in its session files. Sign in to ${name}, then run \`splitbrief doctor\` again.`;
  const copilotExport =
    'Export COPILOT_GITHUB_TOKEN for GitHub Copilot CLI, then run `splitbrief doctor` again.';

  it.each([
    ['darwin', 'claude-code', keychain('Claude Code CLI')],
    ['linux', 'claude-code', sessionFiles('Claude Code CLI')],
    ['darwin', 'codex', sessionFiles('OpenAI Codex CLI')],
    ['linux', 'codex', sessionFiles('OpenAI Codex CLI')],
    ['darwin', 'opencode', sessionFiles('OpenCode CLI')],
    ['linux', 'opencode', sessionFiles('OpenCode CLI')],
    ['darwin', 'copilot', copilotExport],
    ['linux', 'copilot', copilotExport],
    ['darwin', 'kilo-code', sessionFiles('Kilo Code CLI')],
    ['linux', 'kilo-code', sessionFiles('Kilo Code CLI')],
    ['darwin', 'cursor', keychain('Cursor Agent CLI')],
    ['linux', 'cursor', sessionFiles('Cursor Agent CLI')],
    ['darwin', 'command-code', sessionFiles('Command Code CLI')],
    ['linux', 'command-code', sessionFiles('Command Code CLI')],
    ['darwin', 'antigravity', keychain('Google Antigravity CLI')],
    [
      'linux',
      'antigravity',
      'Google Antigravity CLI session authentication is not supported on Linux. Choose another tool in Settings > Crew, or use macOS.',
    ],
  ] as const)(
    'on %s gives a signed-out %s the step of its catalog channel',
    (platform, tool, remediation) => {
      setPlatform(platform);
      expect(deriveCliReadiness(readyFacts({ tool, auth: 'unauthenticated' })).remediation).toBe(
        remediation,
      );
    },
  );

  it.each([
    [
      { installation: 'unavailable', executable: null },
      'Install OpenAI Codex CLI, then run `splitbrief doctor` again.',
    ],
    [
      { trust: 'untrusted' },
      'Install OpenAI Codex CLI outside the project. Put its absolute directory first on PATH, then run `splitbrief doctor` again.',
    ],
    [
      { compatibility: 'incompatible' },
      'Install the tested OpenAI Codex CLI version (0.40.0), then run `splitbrief doctor` again.',
    ],
    [
      { installedVersion: null },
      'Verify OpenAI Codex CLI against tested version 0.40.0, then run `splitbrief doctor` again.',
    ],
  ] as const)('names the tool and an available command for %j', (overrides, remediation) => {
    expect(deriveCliReadiness(readyFacts(overrides)).remediation).toBe(remediation);
  });

  it.each([
    ['ready', {}],
    ['unavailable', { installation: 'unavailable', executable: null }],
    ['untrusted', { trust: 'untrusted' }],
    ['unauthenticated', { auth: 'unauthenticated' }],
    ['incompatible', { compatibility: 'incompatible' }],
    ['unverified', { compatibility: 'unverified' }],
    ['disabled', { enabled: false }],
  ] as const)('derives exactly one %s status from separate facts', (status, overrides) => {
    const result = deriveCliReadiness(readyFacts(overrides));

    expect(result.status).toBe(status);
    expect(result.checkId).toBe('runners.cli.codex.readiness');
    expect(CliReadinessResultSchema.parse(result)).toEqual(result);
    expect(result.remediation === null).toBe(status === 'ready');
  });

  it('uses fail-closed precedence for multiple failed facts', () => {
    expect(
      deriveCliReadiness(
        readyFacts({
          installation: 'unavailable',
          executable: null,
          trust: 'untrusted',
          compatibility: 'incompatible',
          auth: 'unauthenticated',
        }),
      ).status,
    ).toBe('unavailable');
    expect(
      deriveCliReadiness(
        readyFacts({
          trust: 'untrusted',
          compatibility: 'incompatible',
          auth: 'unauthenticated',
        }),
      ).status,
    ).toBe('untrusted');
    expect(
      deriveCliReadiness(readyFacts({ compatibility: 'incompatible', auth: 'unauthenticated' }))
        .status,
    ).toBe('incompatible');
  });

  it('treats unchecked compatibility, auth, and trust as non-ready', () => {
    expect(deriveCliReadiness(readyFacts({ trust: 'not-checked' })).status).toBe('untrusted');
    expect(deriveCliReadiness(readyFacts({ compatibility: 'not-checked' })).status).toBe(
      'unverified',
    );
    expect(deriveCliReadiness(readyFacts({ auth: 'unknown' })).status).toBe('unverified');
    expect(deriveCliReadiness(readyFacts({ auth: 'not-required' })).status).toBe('ready');
  });

  it('requires an installed version before claiming compatibility', () => {
    expect(deriveCliReadiness(readyFacts({ installedVersion: null })).status).toBe('unverified');
    expect(
      deriveCliReadiness(
        readyFacts({
          installedVersion: null,
          compatibility: 'incompatible',
        }),
      ).status,
    ).toBe('unverified');
    expect(
      deriveCliReadiness(readyFacts({ installedVersion: null, auth: 'not-required' })).status,
    ).toBe('unverified');
  });

  it.each(['unauthenticated', 'keyring'] as const)(
    'reports a signed-out tool with an unread version as unauthenticated: %s',
    (auth) => {
      expect(
        deriveCliReadiness(
          readyFacts({ installedVersion: null, compatibility: 'unverified', auth }),
        ).status,
      ).toBe('unauthenticated');
    },
  );

  it('keeps a provider-listing tool with an unread version unverified', () => {
    expect(
      deriveCliReadiness(
        readyFacts({
          tool: 'opencode',
          installedVersion: null,
          compatibility: 'unverified',
          auth: 'unauthenticated',
        }),
      ).status,
    ).toBe('unverified');
  });

  it('remediates unknown authentication without pointing at the tested version', () => {
    // The copy must not promise that re-running a cheap check can verify a
    // session: a local status read proves presence, never validity.
    expect(deriveCliReadiness(readyFacts({ auth: 'unknown' })).remediation).toBe(
      'If a call to OpenAI Codex CLI fails to authenticate, sign in again. Stored credentials do not prove a session; only a real call does.',
    );
    expect(deriveCliReadiness(readyFacts({ auth: 'not-checked' })).remediation).toBe(
      'If a call to OpenAI Codex CLI fails to authenticate, sign in again. Stored credentials do not prove a session; only a real call does.',
    );
    expect(deriveCliReadiness(readyFacts({ compatibility: 'unverified' })).remediation).toBe(
      'Verify OpenAI Codex CLI against tested version 0.40.0, then run `splitbrief doctor` again.',
    );
    expect(deriveCliReadiness(readyFacts({ installedVersion: null })).remediation).toBe(
      'Verify OpenAI Codex CLI against tested version 0.40.0, then run `splitbrief doctor` again.',
    );
  });

  it.each([
    [
      'linux',
      'Google Antigravity CLI session authentication is not supported on Linux. Choose another tool in Settings > Crew, or use macOS.',
    ],
    [
      'darwin',
      'If a call to Google Antigravity CLI fails to authenticate, sign in again. Stored credentials do not prove a session; only a real call does.',
    ],
  ] as const)(
    'on %s gives an unverified Antigravity sign-in the remedy of its catalog channel',
    (platform, remediation) => {
      setPlatform(platform);
      expect(
        cliReadinessRemediation(
          {
            tool: 'antigravity',
            installedVersion: '1.3.5',
            testedVersion: '1.3.5',
            compatibility: 'compatible',
            auth: 'unknown',
          },
          'unverified',
          'doctor',
        ),
      ).toBe(remediation);
    },
  );

  it.each([
    ['doctor', 'then run `splitbrief doctor` again'],
    ['picker', 'then ctrl+r'],
    ['setup', 'then ⏎ on a seat and ctrl+r'],
  ] as const)(
    'tells the %s user to run the version check that timed out in a terminal',
    (recheck, then) => {
      expect(
        cliReadinessRemediation(
          {
            tool: 'codex',
            installedVersion: null,
            testedVersion: '0.40.0',
            compatibility: 'timeout',
          },
          'unverified',
          recheck,
        ),
      ).toBe(`Run \`codex --version\` in a terminal and wait for it to finish, ${then}.`);
    },
  );

  it.each([
    ['doctor', 'then run `splitbrief doctor` again'],
    ['picker', 'then ctrl+r'],
    ['setup', 'then ⏎ on a seat and ctrl+r'],
  ] as const)(
    'tells the %s user to move a Codex keyring sign-in to the file a run reads',
    (recheck, then) => {
      expect(
        cliReadinessRemediation(
          {
            tool: 'codex',
            installedVersion: '0.40.0',
            testedVersion: '0.40.0',
            compatibility: 'compatible',
            auth: 'keyring',
          },
          'unauthenticated',
          recheck,
        ),
      ).toBe(
        `Set cli_auth_credentials_store = "file" in config.toml and run codex login again, ${then}.`,
      );
    },
  );

  it('gives a sign-in check that timed out the unknown sign-in fix', () => {
    expect(deriveCliReadiness(readyFacts({ auth: 'timeout' })).remediation).toBe(
      'If a call to OpenAI Codex CLI fails to authenticate, sign in again. Stored credentials do not prove a session; only a real call does.',
    );
  });

  it('carries optional per-provider oracle facts through derivation and validation', () => {
    const providerAuth = {
      kind: 'read' as const,
      facts: [
        { provider: 'GitHub Copilot', source: 'oauth' as const },
        { provider: 'OpenAI', source: 'env' as const, envVar: 'OPENAI_API_KEY' },
      ],
    };
    const result = deriveCliReadiness(readyFacts({ providerAuth }));

    expect(result.providerAuth).toEqual(providerAuth);
    expect(CliReadinessResultSchema.parse(result)).toEqual(result);
    expect(deriveCliReadiness(readyFacts()).providerAuth).toBeUndefined();
    expect(
      CliReadinessResultSchema.safeParse({
        ...result,
        providerAuth: { kind: 'read', facts: [{ provider: 'OpenAI', source: 'stolen-token' }] },
      }).success,
    ).toBe(false);
  });
});
