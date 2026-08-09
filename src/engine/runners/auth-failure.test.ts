import { describe, expect, it } from 'vitest';
import { defaultCliAuthChannel } from '../../core/runners/cli-tool-catalog.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import {
  isAuthFailureDiagnostic,
  runnerAuthDisplayName,
  runnerLoginInstruction,
} from './auth-failure.js';

// Captured verbatim from `codex exec --json` (codex-cli 0.146.0, 2026-08-06)
// on a host whose refresh token had been rotated away server-side.
const CODEX_BURNED_REFRESH =
  'Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.';
// Captured verbatim the same day from a signed-out CODEX_HOME.
const CODEX_SIGNED_OUT =
  'unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses, cf-ray: a271258d6ded5175-WAW, request id: req_7346f7bf9594404cb642dbe6079577d6';

describe('isAuthFailureDiagnostic', () => {
  it('recognizes the real codex burned-refresh-token turn failure', () => {
    expect(isAuthFailureDiagnostic(CODEX_BURNED_REFRESH)).toBe(true);
  });

  it('recognizes the real codex signed-out 401 turn failure', () => {
    expect(isAuthFailureDiagnostic(CODEX_SIGNED_OUT)).toBe(true);
  });

  it('recognizes Claude Code signed-out result texts', () => {
    expect(isAuthFailureDiagnostic('Invalid API key · Please run /login')).toBe(true);
    expect(isAuthFailureDiagnostic('OAuth token has expired · Please run /login')).toBe(true);
    expect(isAuthFailureDiagnostic('OAuth token revoked · Please run /login')).toBe(true);
    expect(
      isAuthFailureDiagnostic(
        'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
      ),
    ).toBe(true);
  });

  it('recognizes a bare not-logged-in status', () => {
    expect(isAuthFailureDiagnostic('Not logged in')).toBe(true);
  });

  it('does not classify billing, capacity, or ordinary failures as auth', () => {
    expect(isAuthFailureDiagnostic('Credit balance is too low')).toBe(false);
    expect(isAuthFailureDiagnostic('Overloaded: please retry')).toBe(false);
    expect(isAuthFailureDiagnostic('request failed')).toBe(false);
    expect(isAuthFailureDiagnostic('Codex turn failed')).toBe(false);
    expect(isAuthFailureDiagnostic('429 Too Many Requests')).toBe(false);
    expect(isAuthFailureDiagnostic('tsc exited with code 2: src/main.ts(3,1): error TS2304')).toBe(
      false,
    );
  });
});

describe('runnerLoginInstruction', () => {
  function cliImplementer(tool: 'codex' | 'claude-code' | 'copilot') {
    return makeConfig({
      implementer: { kind: 'cli', tool, authChannel: defaultCliAuthChannel(tool).id },
    }).implementer;
  }

  it('names the codex re-login sequence its own message asks for', () => {
    expect(runnerLoginInstruction(cliImplementer('codex'))).toBe(
      'Run `codex logout` then `codex login` in a separate terminal, then retry.',
    );
  });

  it('names the claude /login command', () => {
    expect(runnerLoginInstruction(cliImplementer('claude-code'))).toBe(
      'Run `claude /login` in a separate terminal, then retry.',
    );
  });

  it('stays generic for CLIs without a verified login command', () => {
    expect(runnerLoginInstruction(cliImplementer('copilot'))).toBe(
      'Re-authenticate the GitHub Copilot CLI in a separate terminal, then retry.',
    );
  });

  it('points api runners at their key instead of a login flow', () => {
    const implementer = makeConfig().implementer;
    expect(implementer.kind).toBe('api');
    expect(runnerLoginInstruction(implementer)).toMatch(
      /^Provide a valid .+ API key, then retry\.$/,
    );
  });
});

describe('runnerAuthDisplayName', () => {
  it('uses catalog display names for CLI tools', () => {
    const implementer = makeConfig({
      implementer: { kind: 'cli', tool: 'codex', authChannel: defaultCliAuthChannel('codex').id },
    }).implementer;
    expect(runnerAuthDisplayName(implementer)).toBe('OpenAI Codex CLI');
  });
});
