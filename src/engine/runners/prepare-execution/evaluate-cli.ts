import {
  type RunnerConfig,
  runnerRoleForSlot,
} from '../../../core/config/accessors/runner-config.js';
import { formatSlotLabel } from '../../../core/crew/identity.js';
import type { RunnerEvidence } from '../../../core/discovery/runner-evidence.js';
import { routeSignInCheck } from '../../../core/readiness/checks/cli-readiness.js';
import { UNVERIFIED_AUTH_FIX } from '../../../core/readiness/cli-remediation.js';
import { CLI_TOOL_CATALOG, defaultCliAuthChannel } from '../../../core/runners/cli-tool/catalog.js';
import { type RouteAuthState, routeAuthState } from '../../../core/runners/route-auth.js';
import { READINESS_DIAGNOSTIC_STATE_IDS } from '../../../core/schemas/readiness.js';
import { throwIfAborted } from '../../../utils/abort.js';
import { includes } from '../../../utils/type-guards.js';
import { loadRememberedSnapshot } from '../../detection/cache/store.js';
import { cliSeatDiscoveryContext } from '../../detection/cli-context.js';
import {
  type RouteCatalog,
  savedRouteCatalog,
  routeReadsCatalog,
  freshRouteCatalog,
} from '../../detection/route-catalog.js';
import { runnerDiscoveryContextKey } from '../../detection/context-key.js';
import { resolveSeatModel } from '../host-model-selection.js';
import { type FreshCliStartGateResult, admitFreshCliStart } from '../start-gate.js';
import { cliAdmissionProblem } from './cli-admission.js';
import {
  type RunnerCandidate,
  type PreparationWarning,
  blockedCheck,
  warningCheck,
  admittedCheck,
} from './runner-candidates.js';
import type { PreparationContext, SlotEvaluation } from './types.js';

const READINESS_RETRY_DELAY_MS = 1500;

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export async function evaluateCli(
  candidate: RunnerCandidate & Readonly<{ runner: Extract<RunnerConfig, { kind: 'cli' }> }>,
  context: PreparationContext,
): Promise<SlotEvaluation> {
  const discoveryContext = cliSeatDiscoveryContext({
    role: runnerRoleForSlot(candidate.slot),
    runner: candidate.runner,
    config: context.config,
  });
  const expectedContextKey = runnerDiscoveryContextKey(discoveryContext);
  const detect = (): Promise<RunnerEvidence> =>
    context.deps.detectRunnerEvidence({
      context: discoveryContext,
      projectDir: context.projectDir,
      signal: context.signal,
      versionProbes: context.versionProbes,
    });
  let evidence = await detect();
  throwIfAborted(context.signal);
  const warnings: PreparationWarning[] = [];
  // `auto` is the operator's intent, not a model: the tool would resolve it
  // from its own config, which the run's record and its argv cannot see. Read
  // that selection here and name it, so every surface says what actually ran.
  const details: string[] = [];
  const seatModel = await resolveSeatModel(
    candidate.runner,
    process.env,
    evidence.catalog.kind === 'success' ? evidence.catalog.value : undefined,
  );
  const effectiveModel = seatModel.kind === 'host' ? seatModel.model : undefined;
  if (seatModel.kind === 'host') {
    details.push(`model: auto → ${seatModel.model} (from ${seatModel.source})`);
  } else if (seatModel.kind === 'auto-unread') {
    warnings.push({
      code: 'host_model_selection_unreadable',
      message: `model: auto — ${CLI_TOOL_CATALOG[candidate.runner.tool].displayName} has no readable model selection; the tool's own default applies.`,
    });
  }
  // A tool that stores no credential still calls a provider set up in its own
  // config, so the seat's route, read against its model list, is part of admission.
  let catalog: RouteCatalog | undefined = savedRouteCatalog(
    await loadRememberedSnapshot(context.projectDir),
    candidate.runner.tool,
    seatModel.model,
  );
  const routeOf = (fresh: RunnerEvidence): RouteAuthState =>
    routeAuthState({
      tool: candidate.runner.tool,
      model: seatModel.model,
      providerAuth: fresh.providerAuth,
      catalog,
    });
  const admit = (fresh: RunnerEvidence, route = routeOf(fresh)): FreshCliStartGateResult =>
    admitFreshCliStart({
      tool: candidate.runner.tool,
      evidence: fresh,
      expectedContextKey,
      expectedSelectionId: candidate.runner.model ?? 'unselected',
      interaction: context.policy.interaction,
      unverifiedAuth: context.policy.unverifiedAuth,
      route,
    });
  let admission = admit(evidence);
  // A session channel's auth fact is whatever the tool's own status command
  // answered a moment ago, and that command is cold on the first call of a
  // continue: it can report no session for a host that has one. One denial is
  // not evidence enough to refuse the seat the run is resuming.
  if (
    admission.kind === 'denied' &&
    admission.reason.kind === 'authentication' &&
    defaultCliAuthChannel(candidate.runner.tool).id === 'session'
  ) {
    await wait(READINESS_RETRY_DELAY_MS, context.signal);
    throwIfAborted(context.signal);
    evidence = await detect();
    throwIfAborted(context.signal);
    admission = admit(evidence);
    warnings.push({
      code: 'readiness_probe_retried',
      message: `${CLI_TOOL_CATALOG[candidate.runner.tool].displayName} reported no sign-in at first and confirmed it on a second check.`,
    });
  }
  // The fresh list costs a tool call, so it is read only when the route waits on it and the gate
  // would admit the seat were the route callable: a seat refused on another fact never reads it.
  if (
    routeReadsCatalog(routeOf(evidence)) &&
    admit(evidence, { kind: 'configured', source: 'listed' }).kind === 'admitted'
  ) {
    catalog = await freshRouteCatalog(context.routeCatalogs, candidate.runner.tool, () =>
      context.deps.detectRunnerEvidence({
        context: discoveryContext,
        projectDir: context.projectDir,
        signal: context.signal,
        versionProbes: context.versionProbes,
        includeCatalog: true,
        catalogNamesProject: true,
      }),
    );
    throwIfAborted(context.signal);
    admission = admit(evidence);
  }
  if (admission.kind === 'disclosure-required') {
    return {
      kind: 'blocked',
      check: blockedCheck(
        candidate.slot,
        candidate.runner.kind,
        'Authentication needs review.',
        UNVERIFIED_AUTH_FIX,
      ),
    };
  }
  if (admission.kind === 'denied') {
    const problem = cliAdmissionProblem({
      reason: admission.reason,
      tool: candidate.runner.tool,
      compatibility: evidence.compatibility,
    });
    return {
      kind: 'blocked',
      check: {
        ...blockedCheck(candidate.slot, candidate.runner.kind, problem.message, problem.fix),
        nextAction: 'prepare-runner',
        ...(includes(READINESS_DIAGNOSTIC_STATE_IDS, problem.cause) && {
          diagnosticState: problem.cause,
        }),
        runnerCause: {
          tool: candidate.runner.tool,
          cause: problem.cause,
          seats: [formatSlotLabel(candidate.slot)],
        },
      },
    };
  }
  // The seat starts, but every call on a route with no credential is refused: the seat reads
  // ready with warnings, and the warning code names the readiness route check it restates.
  const routeCheck = routeSignInCheck(candidate.slot, routeOf(evidence));
  if (routeCheck !== undefined) {
    warnings.push({ code: routeCheck.id, message: routeCheck.summary });
  }
  return {
    kind: 'admitted',
    check:
      warnings.length > 0
        ? {
            ...warningCheck(candidate.slot, candidate.runner.kind, warnings, details),
            ...(routeCheck !== undefined && { fix: routeCheck.fix }),
          }
        : admittedCheck(candidate.slot, candidate.runner.kind, details),
    gate: {
      kind: 'cli',
      slot: candidate.slot,
      preparationId: context.preparationId,
      tool: candidate.runner.tool,
      executable: admission.gate.executable,
      installedVersion: admission.gate.installedVersion,
      ...(effectiveModel !== undefined && { effectiveModel }),
    },
  };
}
