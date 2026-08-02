import { error } from '../../utils/error.js';
import { sanitizeTerminalDiagnosticText } from '../../utils/display-text.js';

type Role = 'planner' | 'implementer';

export const RUNNER_OUTCOME_STATES = [
  'spawn-not-found',
  'incompatible-version',
  'unauthenticated',
  'timeout',
  'user-abort',
  'signal-exit',
  'non-zero-exit',
  'protocol-failure',
  'output-budget-breach',
  'callback-failure',
  'no-staged-change',
  'platform-limitation',
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

function defaultRemediation(state: RunnerFailureOutcomeState): string {
  switch (state) {
    case 'spawn-not-found':
      return 'Install the configured CLI, then retry.';
    case 'incompatible-version':
      return 'Install a supported CLI version, then retry.';
    case 'unauthenticated':
      return 'Authenticate the CLI, then retry.';
    case 'timeout':
      return 'Retry the command or increase its configured timeout.';
    case 'user-abort':
      return 'Retry the command when you are ready to continue.';
    case 'signal-exit':
      return 'Inspect the CLI diagnostics for the terminating signal, then retry.';
    case 'non-zero-exit':
      return 'Review the CLI diagnostics, resolve the reported error, then retry.';
    case 'protocol-failure':
      return 'Check the CLI version and output protocol, then retry.';
    case 'output-budget-breach':
      return 'Reduce the requested output or increase the configured output budget.';
    case 'callback-failure':
      return 'Resolve the callback error, then retry.';
    case 'no-staged-change':
      return 'Make the requested change in the staged project, then retry.';
    case 'platform-limitation':
      return 'Run this CLI on a supported platform.';
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
  missingToolConfig: (toolName: string, role: Role) =>
    error(
      'runner-missing-tool-config',
      role === 'planner'
        ? `CLI tool '${toolName}' has no planner configuration`
        : `CLI tool '${toolName}' has no implementer configuration`,
      { toolName, role },
    ),
} as const;
