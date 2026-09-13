import {
  getRunnerDisplayName,
  type DeepReadonly,
  type RunnerConfig,
} from '../../core/config/accessors/runner-config.js';
import { HALT_SIGNATURES } from '../../core/pipeline-spec/halts.js';
import { getProviderDisplayName } from '../../core/providers/catalog.js';
import { CLI_TOOL_CATALOG } from '../../core/runners/cli-tool-catalog.js';

/**
 * Signed-out diagnostics are matched against the one halt phrase set
 * (`HALT_SIGNATURES.auth`) the CLI and the skills share, and only against
 * failure diagnostics (`RunnerCallResult.error.message`), never task output.
 */
export function isAuthFailureDiagnostic(message: string): boolean {
  const text = message.toLowerCase();
  return HALT_SIGNATURES.auth.some((phrase) => text.includes(phrase));
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
