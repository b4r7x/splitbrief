import {
  getRunnerDisplayName,
  type DeepReadonly,
  type RunnerConfig,
} from '../../core/config/accessors/runner-config.js';
import { getProviderDisplayName } from '../../core/providers/catalog.js';
import { CLI_TOOL_CATALOG } from '../../core/runners/cli-tool-catalog.js';

/**
 * Diagnostics a runner emits when its stored credentials no longer work.
 * Matched only against failure diagnostics (`RunnerCallResult.error.message`),
 * never against task output, so tool-specific prose is a safe discriminant.
 *
 * Codex phrases were captured verbatim from `codex exec --json`
 * (codex-cli 0.146.0, 2026-08-06): a burned refresh token reports
 * "Your access token could not be refreshed because your refresh token was
 * already used. Please log out and sign in again."; a signed-out install
 * reports "unexpected status 401 Unauthorized: Missing bearer or basic
 * authentication in header, ...". Claude Code reports its signed-out states
 * as `is_error` result text: "Invalid API key · Please run /login",
 * "OAuth token has expired ...", "OAuth token revoked ...", and surfaces
 * Anthropic's `authentication_error` body for a rejected api-key channel.
 */
const AUTH_FAILURE_PHRASES: readonly string[] = [
  'access token could not be refreshed',
  'log out and sign in again',
  '401 unauthorized',
  'please run /login',
  'invalid api key',
  'oauth token has expired',
  'oauth token revoked',
  'authentication_error',
  'not logged in',
];

export function isAuthFailureDiagnostic(message: string): boolean {
  const text = message.toLowerCase();
  return AUTH_FAILURE_PHRASES.some((phrase) => text.includes(phrase));
}

/** How the runner is named in signed-out messages: catalog names, not config ids. */
export function runnerAuthDisplayName(runner: DeepReadonly<RunnerConfig>): string {
  if (runner.kind === 'cli') return CLI_TOOL_CATALOG[runner.tool].displayName;
  if (runner.kind === 'api') return getProviderDisplayName(runner.provider);
  return getRunnerDisplayName(runner);
}

/**
 * The exact command that restores the runner's login, for the tools whose
 * flow is known first-hand. Codex's own failure message says to log out and
 * sign in again; Claude Code's says to run /login. Tools without a verified
 * login command get an honest generic instruction instead of a guessed one.
 */
export function runnerLoginInstruction(runner: DeepReadonly<RunnerConfig>): string {
  if (runner.kind === 'cli') {
    switch (runner.tool) {
      case 'codex':
        return 'Run `codex logout` then `codex login` in a separate terminal, then retry.';
      case 'claude-code':
        return 'Run `claude /login` in a separate terminal, then retry.';
      default:
        return `Re-authenticate the ${CLI_TOOL_CATALOG[runner.tool].displayName} in a separate terminal, then retry.`;
    }
  }
  if (runner.kind === 'api') {
    return `Provide a valid ${getProviderDisplayName(runner.provider)} API key, then retry.`;
  }
  return `Re-authenticate the ${runnerAuthDisplayName(runner)} runner, then retry.`;
}
