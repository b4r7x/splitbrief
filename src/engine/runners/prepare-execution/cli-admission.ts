import type { RunnerEvidence } from '../../../core/discovery/runner-evidence.js';
import {
  cliReadinessRemediation,
  cliAuthRemediation,
  CODEX_KEYRING_SIGN_IN,
  codexKeyringSignInFix,
  UNVERIFIED_AUTH_FIX,
} from '../../../core/readiness/cli-remediation.js';
import { READINESS_DIAGNOSTIC_REMEDIATION } from '../../../core/readiness/json.js';
import type { RunnerReadinessCauseId } from '../../../core/readiness/types.js';
import { cliAuthChannelPlatformSupported } from '../../../core/runners/cli-tool/auth-channels.js';
import { CLI_TOOL_CATALOG, defaultCliAuthChannel } from '../../../core/runners/cli-tool/catalog.js';
import type { CliToolId } from '../../../core/runners/cli-tool/types.js';
import { assertNever } from '../../../utils/type-guards.js';
import type { FreshCliStartGateResult } from '../start-gate.js';

export function cliAdmissionProblem({
  reason,
  tool,
  compatibility,
}: {
  reason: Extract<FreshCliStartGateResult, { kind: 'denied' }>['reason'];
  tool: CliToolId;
  compatibility: RunnerEvidence['compatibility'];
}): { message: string; fix: string; cause: RunnerReadinessCauseId } {
  const name = CLI_TOOL_CATALOG[tool].displayName;
  const facts: Parameters<typeof cliReadinessRemediation>[0] = {
    tool,
    installedVersion: 'installedVersion' in compatibility ? compatibility.installedVersion : null,
    testedVersion:
      'testedVersion' in compatibility
        ? compatibility.testedVersion
        : CLI_TOOL_CATALOG[tool].compatibility.testedVersion,
    compatibility:
      compatibility.kind === 'compatible' || compatibility.kind === 'timeout'
        ? compatibility.kind
        : 'unverified',
  };
  switch (reason.kind) {
    case 'authentication':
      switch (reason.fact) {
        case 'missing':
          return {
            message: `${name} is not signed in.`,
            cause: 'unauthenticated',
            fix: cliAuthRemediation(tool, 'doctor'),
          };
        case 'keyring':
          return {
            message: CODEX_KEYRING_SIGN_IN,
            cause: 'unauthenticated',
            fix: codexKeyringSignInFix('doctor'),
          };
        case 'invalid':
          return {
            message: `${name} credentials are invalid.`,
            cause: 'unauthenticated',
            fix: cliAuthRemediation(tool, 'doctor'),
          };
        case 'offline':
          return {
            message: `${name} sign-in check could not connect.`,
            cause: 'auth-offline',
            fix: READINESS_DIAGNOSTIC_REMEDIATION['auth-offline'],
          };
        case 'malformed':
          return {
            message: `SPLITBRIEF could not read the ${name} sign-in check result.`,
            cause: 'auth-malformed',
            fix: READINESS_DIAGNOSTIC_REMEDIATION['auth-malformed'],
          };
        case 'policy-denied':
          return {
            message: `${name} sign-in check was denied by a policy.`,
            cause: 'auth-policy-denied',
            fix: !cliAuthChannelPlatformSupported(defaultCliAuthChannel(tool))
              ? cliAuthRemediation(tool, 'doctor')
              : READINESS_DIAGNOSTIC_REMEDIATION['auth-policy-denied'],
          };
        case 'cancelled':
          return {
            message: `${name} sign-in check was cancelled.`,
            cause: 'auth-check-cancelled',
            fix: 'Run `splitbrief doctor` again.',
          };
        case 'not-run':
          return {
            message: `${name} sign-in check did not run.`,
            cause: 'auth-check-not-run',
            fix: 'Run `splitbrief doctor` again.',
          };
        default:
          return assertNever(reason);
      }
    case 'authentication-unverified':
      return reason.fact === 'timeout'
        ? {
            message: `${name} sign-in check timed out.`,
            cause: 'auth-timeout',
            fix: UNVERIFIED_AUTH_FIX,
          }
        : {
            message: `${name} sign-in status is unknown.`,
            cause: 'auth-unknown',
            fix: UNVERIFIED_AUTH_FIX,
          };
    case 'installation':
    case 'executable':
      if (reason.fact === 'missing') {
        return {
          message: `${name} is not installed.`,
          cause: 'missing-binary',
          fix: cliReadinessRemediation(facts, 'unavailable', 'doctor'),
        };
      }
      if (reason.kind === 'installation') {
        return {
          message: `${name} installation could not be checked.`,
          cause: 'installation-unchecked',
          fix: `Check that ${name} is installed and on PATH, then run \`splitbrief doctor\` again.`,
        };
      }
      return {
        message: `${name} executable could not be trusted.`,
        cause: 'untrusted-path',
        fix: cliReadinessRemediation(facts, 'untrusted', 'doctor'),
      };
    case 'compatibility':
      if (reason.fact === 'incompatible') {
        return {
          message: `${name} version is not compatible.`,
          cause: 'incompatible-version',
          fix: cliReadinessRemediation(facts, 'incompatible', 'doctor'),
        };
      }
      if (reason.fact === 'timeout') {
        return {
          message: `${name} version check timed out.`,
          cause: 'version-timeout',
          fix: cliReadinessRemediation(facts, 'unverified', 'doctor'),
        };
      }
      return {
        message: `${name} version could not be confirmed as compatible.`,
        cause: 'unknown-version',
        fix: cliReadinessRemediation(facts, 'unverified', 'doctor'),
      };
    case 'disabled':
      return {
        message: `${name} is disabled.`,
        cause: 'disabled',
        fix: cliReadinessRemediation(facts, 'disabled', 'doctor'),
      };
    case 'context-mismatch':
    case 'evidence-source':
    case 'model-context-mismatch':
      return {
        message: `${name} checks do not match the current configuration.`,
        cause: 'stale-checks',
        fix: 'Run `splitbrief doctor` again.',
      };
    case 'probe':
      return {
        message: `${name} could not check its connection or available models.`,
        cause: 'probe-failed',
        fix: 'Check the network connection, then run `splitbrief doctor` again.',
      };
    case 'model-run':
      return {
        message: `${name} has not confirmed that the selected model can run.`,
        cause: 'model-unconfirmed',
        fix: `Check the selected model in ${name}, or choose another model in Settings > Crew.`,
      };
    default:
      return assertNever(reason);
  }
}
