import { CREW_SEAT_LABELS } from '../../../../core/crew/identity.js';
import { cliToolIdForCommand } from '../../../../core/runners/cli-tool/catalog.js';
import type { ActiveRunnerRole } from '../../../../core/runners/seat-roles.js';
import type { EngineEventOf } from '../../../../engine/events/types.js';
import { resolveModelDisplayName } from '../../../../engine/providers/model/display-names.js';
import type { ModelCacheAccessor } from '../../../../engine/providers/model/runtime-snapshot.js';
import { modelCacheStore } from '../../../../stores/discovery/model-cache/state.js';
import { assertNever } from '../../../../utils/type-guards.js';
import type { RunnerActivityDisplayInput } from './types.js';

/**
 * Spells the raw model ids a fallback or refusal warning interpolates with the
 * names the origin call's runner catalog uses, keeping a raw id the catalog does
 * not know. Longest id first, so a shorter id never rewrites part of a longer
 * sibling. Returns null when the row named no ids (historical or incomplete
 * records), no message carries them, or nothing resolved.
 */
export function resolveRunnerActivityModelNames(
  input: RunnerActivityDisplayInput,
  cache: ModelCacheAccessor = modelCacheStore,
): string | null {
  const message = input.diagnosticPartial;
  if (message === undefined) return null;
  if (input.role === undefined) return null;
  const providerId = activityModelProviderId(input.runnerName);
  if (providerId === undefined) return null;
  const rawIds = [input.originalModel, input.fallbackModel].filter(
    (model): model is string => model !== undefined && model.length > 0,
  );
  if (rawIds.length === 0) return null;

  let text = message;
  for (const model of [...rawIds].sort((left, right) => right.length - left.length)) {
    const displayName = resolveModelDisplayName({
      providerId,
      model,
      role: runnerActivityModelRole(input.role),
      cache,
      kind: input.backendKind,
    });
    if (displayName === undefined || displayName === model) continue;
    text = text.split(model).join(displayName);
  }
  return text === message ? null : text;
}

function activityModelProviderId(runnerName: string | undefined): string | undefined {
  if (runnerName === undefined) return undefined;
  return cliToolIdForCommand(runnerName) ?? runnerName;
}

/** The seat whose model catalog names the call's model; the planner's runner makes the side calls. */
export function runnerActivityModelRole(
  role: EngineEventOf<'runner_call_activity'>['role'],
): ActiveRunnerRole {
  switch (role) {
    case 'implementer':
      return 'implementer';
    case 'review':
      return 'reviewer';
    case 'planner':
    case 'summary':
    case 'compaction':
    case 'escalation':
      return 'planner';
    default:
      return assertNever(role);
  }
}

export function runnerActivityRoleLabel(
  role: EngineEventOf<'runner_call_activity'>['role'],
): string {
  switch (role) {
    case 'planner':
      return CREW_SEAT_LABELS.plan;
    case 'implementer':
      return CREW_SEAT_LABELS.build;
    case 'review':
      return CREW_SEAT_LABELS.review;
    case 'summary':
      return 'Summary';
    case 'compaction':
      return 'Compaction';
    case 'escalation':
      return 'Escalation';
    default:
      return assertNever(role);
  }
}
