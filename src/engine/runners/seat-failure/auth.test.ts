import { describe, expect, it } from 'vitest';
import { HALT_SIGNATURES } from '../../../core/pipeline-spec/halts.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import {
  isAuthFailureDiagnostic,
  modelRefusalMessage,
  runnerAccountDisplayName,
  runnerLoginInstruction,
} from './auth.js';

// Captured verbatim from `codex exec --json` (codex-cli 0.146.0, 2026-08-06)
// on a host whose refresh token had been rotated away server-side.
const CODEX_BURNED_REFRESH =
  'Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.';
// Captured verbatim the same day from a signed-out CODEX_HOME.
const CODEX_SIGNED_OUT =
  'unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses, cf-ray: a271258d6ded5175-WAW, request id: req_7346f7bf9594404cb642dbe6079577d6';

describe('isAuthFailureDiagnostic', () => {
  it.each([
    ...HALT_SIGNATURES.auth,
    CODEX_BURNED_REFRESH,
    CODEX_SIGNED_OUT,
    'Please log out and sign in again.',
    'Invalid API key · Please run /login',
    'OAuth token has expired · Please run /login',
    'OAuth token revoked · Please run /login',
    'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
    'Not logged in',
    'Error: not logged in',
    'not logged in to any provider',
    'Not logged in · Please run /login',
    'Not logged in. Run cursor-agent login.',
    'Error: Your session ended. Please sign in again to continue.',
    'Your session ended. Please sign in.',
    'Please sign in again in Settings.',
    'Please sign in again',
    'Please sign in to continue.',
    'Please sign in to view available models. Launch the CLI without arguments to sign in.',
    'Not authenticated',
    'Error: Not authenticated. Please run "cmd login" first.',
    "Error: Authentication required. Please run 'agent login' first, or set CURSOR_API_KEY environment variable.",
    'HTTP 403 Forbidden',
    'unexpected status 403: access denied',
    '{"error":{"message":"denied"},"status":403}',
    'Error: unauthenticated',
  ])('recognizes %j', (message) => {
    expect(isAuthFailureDiagnostic(message)).toBe(true);
  });

  it.each([
    'Sign in successful.',
    'Sign in was successful.',
    'Signed in as user@example.com',
    'Successfully signed in',
    'You are signed in',
    'No authentication required.',
    'No need to log in.',
    'Sign in to GitHub to see more',
    'Log in with --token',
    'No active session',
    'Not signed in',
    'Commands:\n  login  Manage credentials\n  run    Run a task',
  ])('does not classify %j as signed out', (message) => {
    expect(isAuthFailureDiagnostic(message)).toBe(false);
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
      implementer: { kind: 'cli', tool },
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

describe('modelRefusalMessage', () => {
  it('names the model the seat runs', () => {
    expect(
      modelRefusalMessage(
        { kind: 'cli', tool: 'opencode', model: 'openai/gpt-nope' },
        'wrong-model',
      ),
    ).toBe('Model openai/gpt-nope is not listed by OpenCode CLI; pick a listed model');
  });

  it('names the provider by its sign-in id when either cause fits', () => {
    expect(
      modelRefusalMessage({ kind: 'cli', tool: 'opencode', model: 'ollama/llama3' }, 'unknown'),
    ).toBe(
      'OpenCode CLI cannot use ollama/llama3: sign in with `opencode auth login ollama` if ollama has no credential, or pick a listed model',
    );
  });

  it("names the tool's default model when the seat names none", () => {
    for (const refusal of ['wrong-model', 'unknown'] as const) {
      expect(modelRefusalMessage({ kind: 'cli', tool: 'opencode' }, refusal)).toBe(
        'OpenCode CLI refused its default model; pick a listed model',
      );
    }
  });
});

describe('runnerLoginInstruction for a custom API provider', () => {
  it('keeps a custom API provider literal even when it reuses a CLI tool id', () => {
    const implementer = makeConfig({
      implementer: {
        kind: 'api',
        provider: 'opencode',
        service: 'opencode',
        offering: 'payg',
        apiBase: 'https://my-endpoint.example/v1',
        apiKey: 'sk-inline',
      },
    }).implementer;

    expect(runnerLoginInstruction(implementer)).toBe(
      'Provide a valid opencode API key, then retry.',
    );
  });
});

describe('runnerAccountDisplayName', () => {
  it.each([
    [
      { kind: 'cli', tool: 'opencode', model: 'deepseek/deepseek-flash' },
      'deepseek (OpenCode CLI)',
    ],
    [{ kind: 'cli', tool: 'opencode', model: 'ollama/llama3' }, 'ollama (OpenCode CLI)'],
    [{ kind: 'cli', tool: 'opencode' }, 'OpenCode CLI'],
    [{ kind: 'cli', tool: 'claude-code', model: 'sonnet' }, 'Claude Code CLI'],
  ] as const)('names the account holder of %o', (implementer, name) => {
    expect(runnerAccountDisplayName(makeConfig({ implementer }).implementer)).toBe(name);
  });
});
