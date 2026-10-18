import { runnerSlotId, type RunnerConfigSlot } from '../../config/accessors/runner-config.js';
import { formatSlotLabel } from '../../crew/identity.js';
import type { SavedCatalog } from '../../discovery/catalog-read-merge.js';
import {
  CLI_TOOL_CATALOG,
  type CliToolId,
  type CliAuthChannelId,
} from '../../runners/cli-tool-catalog.js';
import {
  routeAuthState,
  routeNoCredential,
  routeSignInCommand,
  type RouteAuthState,
} from '../../runners/route-auth.js';
import {
  cliReadinessCheckId,
  type CliReadinessResult,
  type ReadinessDiagnosticStateId,
} from '../../schemas/readiness.js';
import type { ReadinessCheck, RunnerReadinessCauseId } from '../types.js';
import { assertNever } from '../../../utils/type-guards.js';

const REDACTED_EXECUTABLE_PATH = '[redacted executable path]';

/**
 * Readiness keeps the trusted identity for the start gate, but diagnostics are
 * public output (including `doctor --json`). Never publish the identity path.
 */
function diagnosticExecutablePath(result: CliReadinessResult): string | null {
  return result.executable === null ? null : REDACTED_EXECUTABLE_PATH;
}

/** A tool's remembered model catalog, which tells a route set up in the tool's own config. */
export type RememberedToolCatalog = Readonly<{ tool: CliToolId }> & SavedCatalog;

/** What each configured CLI seat's route is read against. */
export type CliRouteInputs = Readonly<{
  /** The model each CLI seat calls, by `runnerSlotId`: `auto` or no model resolved as start does. */
  seatModels: ReadonlyMap<string, string | undefined>;
  /** The tools' model lists: the saved list, or a fresh read when none is saved and a route waits on it. */
  catalogs: readonly RememberedToolCatalog[];
}>;

/** One seat of a configured CLI, as readiness reads it. */
export type ConfiguredCliSeat = Readonly<{
  slot: RunnerConfigSlot;
  authChannel: CliAuthChannelId;
  model: string | undefined;
}>;

/**
 * A seat whose model route the tool's own credential listing does not sign
 * in: the tool is ready, but every call on that route is refused. Readiness
 * and start report it the same way, with the tool's sign-in command.
 */
export function routeSignInCheck(
  slot: RunnerConfigSlot,
  auth: RouteAuthState,
): ReadinessCheck | undefined {
  if (auth.kind !== 'needs-sign-in') return undefined;
  const seat = formatSlotLabel(slot);
  return {
    id: `runners.route.${runnerSlotId(slot)}`,
    severity: 'warning',
    summary: `${seat}: ${routeNoCredential(auth.tool, auth.provider)}.`,
    fix: `Run \`${routeSignInCommand(auth.tool, auth.provider)}\`, or choose another model in Settings > Crew > ${seat}.`,
  };
}

export function configuredCliReadinessChecks(
  configuredTools: ReadonlyMap<CliToolId, readonly ConfiguredCliSeat[]>,
  results: readonly CliReadinessResult[],
  catalogs: readonly RememberedToolCatalog[],
): ReadinessCheck[] {
  const resultsByTool = new Map(results.map((result) => [result.tool, result]));
  return [...configuredTools].flatMap(([tool, seats]) => {
    const result = resultsByTool.get(tool);
    if (result === undefined) return [missingCliReadinessCheck(tool)];
    const catalog = catalogs.find((saved) => saved.tool === tool);
    const routes = seats.map((seat) => ({
      seat,
      auth: routeAuthState({
        tool,
        model: seat.model,
        providerAuth: result.providerAuth,
        catalog,
      }),
    }));
    const routeChecks = routes.flatMap(({ seat, auth }) => routeSignInCheck(seat.slot, auth) ?? []);
    // A tool that stores no credential still calls a provider set up in its own
    // config: a seat whose route its model list serves needs no sign-in.
    const signInSeats =
      result.status === 'unauthenticated'
        ? routes.filter(({ auth }) => auth.kind !== 'configured').map(({ seat }) => seat)
        : seats;
    if (signInSeats.length === 0) return [configRoutedCliReadinessCheck(result), ...routeChecks];
    return [cliToolReadinessCheck(tool, signInSeats, result), ...routeChecks];
  });
}

function configRoutedCliReadinessCheck(result: CliReadinessResult): ReadinessCheck {
  const { id, metadata } = cliReadinessCheck(result);
  return {
    id,
    metadata,
    severity: 'ok',
    summary: `${CLI_TOOL_CATALOG[result.tool].displayName} is installed, trusted, compatible, and stores no credential; it calls the providers set up in its config.`,
  };
}

function cliToolReadinessCheck(
  tool: CliToolId,
  seats: readonly ConfiguredCliSeat[],
  result: CliReadinessResult,
): ReadinessCheck {
  const check = cliReadinessCheck(result);
  const cause = cliReadinessCause(result, check.diagnosticState);
  if (cause === undefined) return check;
  // Only a sign-in fact depends on the seat's authentication selection; a
  // missing, untrusted or unproven executable blocks every seat of the tool.
  const authentication = cause === 'unauthenticated' || cause === 'auth-unknown';
  const authChannel = authentication ? result.authChannel : undefined;
  if (authentication && authChannel === undefined) return check;
  check.runnerCause = {
    tool,
    cause,
    ...(authChannel !== undefined && { authChannel }),
    seats: seats
      .filter((seat) => authChannel === undefined || seat.authChannel === authChannel)
      .map((seat) => formatSlotLabel(seat.slot)),
  };
  return check;
}

function cliReadinessCause(
  result: CliReadinessResult,
  diagnosticState: ReadinessDiagnosticStateId | undefined,
): RunnerReadinessCauseId | undefined {
  if (diagnosticState !== undefined) return diagnosticState;
  if (result.status === 'disabled') return 'disabled';
  if (
    result.status === 'unverified' &&
    (result.installedVersion === null || result.compatibility !== 'compatible')
  ) {
    return 'unknown-version';
  }
  return undefined;
}

function missingCliReadinessCheck(tool: CliToolId): ReadinessCheck {
  const descriptor = CLI_TOOL_CATALOG[tool];
  return {
    id: cliReadinessCheckId(tool),
    severity: 'blocker',
    summary: `${descriptor.displayName} has no current readiness probe result.`,
    nextAction: 'prepare-runner',
    fix: `Run \`splitbrief doctor\` again to check ${descriptor.displayName}.`,
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
      return result.installedVersion !== null &&
        result.compatibility === 'compatible' &&
        result.auth === 'unknown'
        ? 'auth-unknown'
        : undefined;
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
    summary: cliReadinessSummary(result, descriptor.displayName),
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

function cliReadinessSummary(result: CliReadinessResult, name: string): string {
  switch (result.status) {
    case 'ready':
      return result.auth === 'not-required'
        ? `${name} is installed, trusted, compatible, and does not require authentication.`
        : `${name} is installed, trusted, compatible, and signed in.`;
    case 'disabled':
      return `${name} is disabled.`;
    case 'unavailable':
      return `${name} is not installed.`;
    case 'untrusted':
      return `${name} executable could not be trusted.`;
    case 'incompatible':
      return `${name} version is not compatible.`;
    case 'unauthenticated':
      return `${name} is not signed in.`;
    case 'unverified':
      return result.installedVersion === null || result.compatibility !== 'compatible'
        ? `${name} version could not be confirmed as compatible.`
        : `${name} sign-in status is unknown.`;
    default:
      return assertNever(result);
  }
}
