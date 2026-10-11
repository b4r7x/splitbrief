import {
  candidateIdsOf,
  formatSeatChangeIdentities,
  formatSeatIdentity,
  type SeatIds,
} from '../../../core/crew/identity.js';
import { cliToolIdForCommand } from '../../../core/runners/cli-tool-catalog.js';
import type { ActiveRunnerRole } from '../../../core/runners/seat-roles.js';
import { resolveModelDisplayName } from '../../../engine/providers/model/display-names.js';
import { modelCacheStore } from '../../../stores/discovery/model-cache/state.js';

export function formatRecordedSeatIdentity(
  input: Readonly<{
    runnerName?: SeatIds['tool'] | undefined;
    model?: SeatIds['model'];
    axes?: SeatIds['axes'];
    backendKind?: SeatIds['kind'];
    role: ActiveRunnerRole;
  }>,
): string | null {
  if (input.runnerName === undefined) return null;
  return formatSeatIdentity(
    recordedIdentityInput(
      {
        tool: input.runnerName,
        model: input.model,
        axes: input.axes ?? [],
        kind: input.backendKind,
      },
      input.role,
    ),
  );
}

export function formatRecordedSeatChangeIdentities(
  from: Parameters<typeof candidateIdsOf>[0],
  to: Parameters<typeof candidateIdsOf>[0],
  role: ActiveRunnerRole,
): Readonly<{ from: string; to: string }> {
  return formatSeatChangeIdentities(
    from.model === undefined ? from : recordedIdentityInput(candidateIdsOf(from), role),
    to.model === undefined ? to : recordedIdentityInput(candidateIdsOf(to), role),
  );
}

function recordedIdentityInput(
  seat: SeatIds,
  role: ActiveRunnerRole,
): Parameters<typeof formatSeatIdentity>[0] {
  const tool =
    seat.kind === 'cli' || seat.kind === undefined
      ? (cliToolIdForCommand(seat.tool) ?? seat.tool)
      : seat.tool;
  const displayName =
    seat.model === undefined
      ? undefined
      : resolveModelDisplayName({
          providerId: tool,
          model: seat.model,
          role,
          kind: seat.kind,
          cache: modelCacheStore,
        });
  return {
    seat: { ...seat, tool },
    displayName,
  };
}
