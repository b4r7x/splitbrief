import {
  getRunnerCatalogDisplayName,
  type DeepReadonly,
  type RunnerConfig,
} from '../../../core/config/accessors/runner-config.js';
import { HALT_SIGNATURES } from '../../../core/pipeline-spec/halts.js';
import { getRunnerIdentityDisplayName } from '../../../core/providers/catalog.js';
import { CLI_TOOL_CATALOG } from '../../../core/runners/cli-tool/catalog.js';
import {
  modelProviderAuthKey,
  routeSignInCommand,
  type ModelRefusal,
} from '../../../core/runners/route-auth.js';

const SIGN_IN_REFUSALS = [
  'your session ended. please sign in.',
  'please sign in again',
  'please sign in to continue.',
  'please sign in to view available models. launch the cli without arguments to sign in.',
];

/**
 * Signed-out diagnostics match the shared halt phrases (`HALT_SIGNATURES.auth`),
 * known sign-in refusals, the word "unauthenticated", or explicit HTTP 403 diagnostics.
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
    SIGN_IN_REFUSALS.some((phrase) => text.includes(phrase))
  );
}

/** The provider a provider-dependent tool's model route names (`deepseek/…` → `deepseek`). */
function routeProvider(runner: DeepReadonly<RunnerConfig>): string | undefined {
  if (runner.kind !== 'cli' || CLI_TOOL_CATALOG[runner.tool].auth.kind !== 'provider-dependent') {
    return undefined;
  }
  return runner.model === undefined ? undefined : modelProviderAuthKey(runner.model);
}

/**
 * Who holds the account a refusal names, as every halt names it. A provider-dependent tool signs
 * in and bills the provider its model route names (`deepseek/…` on OpenCode spends DeepSeek's
 * balance: `deepseek (OpenCode CLI)`); every other runner holds its own account.
 */
export function runnerAccountDisplayName(runner: DeepReadonly<RunnerConfig>): string {
  const provider = routeProvider(runner);
  const tool = getRunnerCatalogDisplayName(runner);
  return provider === undefined ? tool : `${provider} (${tool})`;
}

/**
 * The exact command that restores the runner's login, for the tools whose
 * flow is known first-hand. Codex's own failure message says to log out and
 * sign in again; Claude Code's says to run /login. Tools without a verified
 * login command get an honest generic instruction instead of a guessed one.
 */
export function runnerLoginInstruction(runner: DeepReadonly<RunnerConfig>): string {
  const provider = routeProvider(runner);
  if (runner.kind === 'cli' && provider !== undefined) {
    return `Run \`${routeSignInCommand(runner.tool, provider)}\` in a separate terminal, then retry.`;
  }
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
  return `Re-authenticate the ${getRunnerCatalogDisplayName(runner)} runner, then retry.`;
}

/**
 * A model refusal that is not a known sign-out: a model the tool does not list,
 * or, with the route's credential listing unread, both causes and both remedies.
 */
export function modelRefusalMessage(
  runner: DeepReadonly<RunnerConfig>,
  refusal: ModelRefusal,
): string {
  const tool = getRunnerCatalogDisplayName(runner);
  const model = 'model' in runner ? runner.model : undefined;
  if (model === undefined) return `${tool} refused its default model; pick a listed model`;
  const provider = routeProvider(runner);
  if (refusal === 'unknown' && runner.kind === 'cli' && provider !== undefined) {
    return `${tool} cannot use ${model}: sign in with \`${routeSignInCommand(runner.tool, provider)}\` if ${provider} has no credential, or pick a listed model`;
  }
  return `Model ${model} is not listed by ${tool}; pick a listed model`;
}
