import { CLI_TOOL_CATALOG, type CliToolId } from '../../runners/cli-tool-catalog.js';
import {
  cliReadinessCheckId,
  type CliReadinessResult,
  type ReadinessDiagnosticStateId,
} from '../../schemas/readiness.js';
import type { ReadinessCheck } from '../types.js';
import { assertNever } from '../../../utils/type-guards.js';

const REDACTED_EXECUTABLE_PATH = '[redacted executable path]';

/**
 * Readiness keeps the trusted identity for the start gate, but diagnostics are
 * public output (including `doctor --json`). Never publish the identity path.
 */
function diagnosticExecutablePath(result: CliReadinessResult): string | null {
  return result.executable === null ? null : REDACTED_EXECUTABLE_PATH;
}

export function configuredCliReadinessChecks(
  configuredTools: ReadonlySet<CliToolId>,
  results: readonly CliReadinessResult[],
): ReadinessCheck[] {
  const resultsByTool = new Map(results.map((result) => [result.tool, result]));
  return [...configuredTools].map((tool) => {
    const result = resultsByTool.get(tool);
    return result ? cliReadinessCheck(result) : missingCliReadinessCheck(tool);
  });
}

function missingCliReadinessCheck(tool: CliToolId): ReadinessCheck {
  const descriptor = CLI_TOOL_CATALOG[tool];
  return {
    id: cliReadinessCheckId(tool),
    severity: 'blocker',
    summary: `${descriptor.displayName} has no current readiness probe result.`,
    nextAction: 'prepare-runner',
    fix: `Run runner readiness for ${tool}, then start again.`,
    metadata: {
      tool,
      status: 'unverified',
      installation: 'not-checked',
      trust: 'not-checked',
      compatibility: 'not-checked',
      auth: 'not-checked',
      executablePath: null,
    },
  };
}

function cliReadinessDiagnosticState(
  result: CliReadinessResult,
): ReadinessDiagnosticStateId | undefined {
  switch (result.status) {
    case 'unavailable':
      return 'missing-binary';
    case 'untrusted':
      return 'untrusted-path';
    case 'incompatible':
      return 'incompatible-version';
    case 'unauthenticated':
      return 'unauthenticated';
    case 'unverified':
      return result.auth === 'unknown' ? 'auth-unknown' : undefined;
    case 'ready':
    case 'disabled':
      return undefined;
    default:
      return assertNever(result);
  }
}

function cliReadinessCheck(result: CliReadinessResult): ReadinessCheck {
  const descriptor = CLI_TOOL_CATALOG[result.tool];
  const severity =
    result.status === 'ready' ? 'ok' : result.status === 'unverified' ? 'warning' : 'blocker';
  const diagnosticState = cliReadinessDiagnosticState(result);
  return {
    id: result.checkId,
    severity,
    summary:
      result.status === 'ready'
        ? result.auth === 'not-required'
          ? `${descriptor.displayName} is installed, trusted, compatible, and does not require authentication.`
          : `${descriptor.displayName} is installed, trusted, compatible, and authenticated.`
        : `${descriptor.displayName} readiness is ${result.status}.`,
    ...(result.remediation !== null && { fix: result.remediation }),
    ...(diagnosticState !== undefined && { diagnosticState }),
    ...(severity === 'blocker' && { nextAction: 'prepare-runner' as const }),
    metadata: {
      tool: result.tool,
      status: result.status,
      installation: result.installation,
      trust: result.trust,
      installedVersion: result.installedVersion,
      testedVersion: result.testedVersion,
      compatibility: result.compatibility,
      auth: result.auth,
      executablePath: diagnosticExecutablePath(result),
      probedAt: result.probedAt,
    },
  };
}
