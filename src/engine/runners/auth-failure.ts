import {
  getRunnerDisplayName,
  type DeepReadonly,
  type RunnerConfig,
} from '../../core/config/accessors/runner-config.js';
import { HALT_SIGNATURES } from '../../core/pipeline-spec/halts.js';
import { getRunnerIdentityDisplayName } from '../../core/providers/catalog.js';
import { CLI_TOOL_CATALOG } from '../../core/runners/cli-tool-catalog.js';
import { isRecord } from '../../utils/type-guards.js';

/**
 * Signed-out diagnostics match the shared halt phrases (`HALT_SIGNATURES.auth`),
 * the word "unauthenticated", "sign in", "http 403", "status 403", or '"status":403'.
 * The additional forms are diagnostic-only because the stdout tail carries
 * test logs. These matches apply only to failure diagnostics
 * (`RunnerCallResult.error.message`), never task output.
 */
export function isAuthFailureDiagnostic(message: string): boolean {
  const text = message.toLowerCase();
  return (
    HALT_SIGNATURES.auth.some((phrase) => text.includes(phrase)) ||
    /(?:http |status |"status":)403\b/.test(text) ||
    /\bunauthenticated\b/.test(text) ||
    /\bsign in\b/.test(text)
  );
}

/** A thrown runner error's HTTP status marks a rejected login at 401 or 403. */
export function isAuthFailureError(err: unknown): boolean {
  if (!isRecord(err) || !isRecord(err.data)) return false;
  const status = err.data.status ?? err.data.statusCode;
  return status === 401 || status === 403;
}

/** How the runner is named in signed-out messages: catalog names, not config ids. */
export function runnerAuthDisplayName(runner: DeepReadonly<RunnerConfig>): string {
  if (runner.kind === 'cli') return CLI_TOOL_CATALOG[runner.tool].displayName;
  if (runner.kind === 'api') return getRunnerIdentityDisplayName('api', runner.provider);
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
    return `Provide a valid ${getRunnerIdentityDisplayName('api', runner.provider)} API key, then retry.`;
  }
  return `Re-authenticate the ${runnerAuthDisplayName(runner)} runner, then retry.`;
}
