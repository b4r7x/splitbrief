import { error } from '../../utils/error.js';
import { sanitizeTerminalDiagnosticText } from '../../utils/display-text.js';
import type { ActiveRunnerRole } from '../../core/runners/seat-roles.js';

export const RUNNER_OUTCOME_STATES = [
  'spawn-not-found',
  'incompatible-version',
  'unauthenticated',
  'usage-limit',
  'input-too-large',
  'timeout',
  'no-progress-cut',
  'user-abort',
  'signal-exit',
  'non-zero-exit',
  'protocol-failure',
  'output-budget-breach',
  'callback-failure',
  'no-staged-change',
  'platform-limitation',
  'implementer-effect-invalid',
  'implementer-recipe-invalid',
  'implementer-left-isolation',
  'checkout-changed',
  'runner-timeout-repeated',
  'missing-model',
  'success',
] as const;

export type RunnerOutcomeState = (typeof RUNNER_OUTCOME_STATES)[number];
export type RunnerFailureOutcomeState = Exclude<RunnerOutcomeState, 'success'>;

export type RunnerSuccessOutcome = Readonly<{ state: 'success'; remediation: null }>;
export type RunnerFailureOutcome = Readonly<{
  state: RunnerFailureOutcomeState;
  remediation: string;
}>;
export type RunnerOutcome = RunnerSuccessOutcome | RunnerFailureOutcome;

/** What the next attempt hears after SPLITBRIEF discarded some of its writes. */
export const DISCARDED_WRITES_INSTRUCTION =
  'Retry from the current files; do not try to recover the rejected writes.';

function defaultRemediation(state: RunnerFailureOutcomeState): string {
  switch (state) {
    case 'spawn-not-found':
      return 'Install the configured CLI, then retry.';
    case 'incompatible-version':
      return 'Install a supported CLI version, then retry.';
    case 'unauthenticated':
      return 'Authenticate the CLI, then retry.';
    case 'usage-limit':
      return 'Wait for the usage limit to reset, switch the seat to another tool, or end the run.';
    case 'input-too-large':
      return 'The prompt is larger than the tool accepts; a retry sends the same prompt. Narrow the input or end the run.';
    case 'timeout':
      return 'Retry the command or increase its configured timeout.';
    case 'no-progress-cut':
      return 'The runner produced no output past its idle limit with no child process running and was stopped; the task is retried.';
    case 'user-abort':
      return 'Retry the command when you are ready to continue.';
    case 'signal-exit':
      return 'Inspect the CLI diagnostics for the terminating signal, then retry.';
    case 'non-zero-exit':
      return 'Review the CLI diagnostics, resolve the reported error, then retry.';
    case 'protocol-failure':
      return 'Check the CLI version and output protocol, then retry.';
    case 'output-budget-breach':
      return 'The tool wrote more than 64 MB of output and was stopped. Narrow what it was asked to print, then retry.';
    case 'callback-failure':
      return 'Resolve the callback error, then retry.';
    case 'no-staged-change':
      return 'Make the requested change in the staged project, then retry.';
    case 'platform-limitation':
      return 'Run this CLI on a supported platform.';
    case 'implementer-effect-invalid':
      return `The implementer wrote a file this call does not allow, so the attempt failed and its rejected writes do not count. ${DISCARDED_WRITES_INSTRUCTION}`;
    case 'implementer-recipe-invalid':
      return 'Correct the tool recipe (flags or permissions) and retry; this attempt consumed no retry.';
    case 'implementer-left-isolation':
      return 'The implementer reached outside its isolation directory and was stopped. Check your checkout, then retry, switch the seat or skip the brief.';
    case 'checkout-changed':
      return "Your checkout's git state changed while the implementer ran, and SPLITBRIEF reverted nothing. Check the named changes, then retry, switch the seat or skip the brief.";
    case 'runner-timeout-repeated':
      return 'Two consecutive attempts timed out; switch the seat, route a bigger worker, or skip.';
    case 'missing-model':
      return 'Pick a model the tool lists, then retry.';
    default: {
      const _exhaustive: never = state;
      return _exhaustive;
    }
  }
}

export const runnerOutcome = {
  success: (): RunnerSuccessOutcome => ({ state: 'success', remediation: null }),
  failure: (state: RunnerFailureOutcomeState, remediation?: string): RunnerFailureOutcome => {
    const bounded =
      remediation === undefined ? '' : sanitizeTerminalDiagnosticText(remediation).trim();
    return { state, remediation: bounded || defaultRemediation(state) };
  },
} as const;

export const runnerConfigError = {
  missingToolConfig: (toolName: string, role: ActiveRunnerRole) =>
    error('runner-missing-tool-config', `CLI tool '${toolName}' has no ${role} configuration`, {
      toolName,
      role,
    }),
} as const;
