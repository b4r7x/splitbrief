import { formatSeatIdentity, type SeatIds } from '../../../core/crew/identity.js';
import type { ActiveRunnerRole } from '../../../core/runners/seat-roles.js';
import {
  recordedSeatIdentityInput as buildRecordedSeatIdentityInput,
  resolveSeatChangeIdentities,
} from '../../../engine/providers/model/display-names.js';
import { modelCacheStore } from '../../../stores/discovery/model-cache/state.js';

export function recordedSeatIdentityInput(
  input: Readonly<{
    runnerName?: SeatIds['tool'] | undefined;
    model?: SeatIds['model'];
    axes?: SeatIds['axes'];
    backendKind?: SeatIds['kind'];
    role: ActiveRunnerRole;
  }>,
): Parameters<typeof formatSeatIdentity>[0] | null {
  if (input.runnerName === undefined) return null;
  return buildRecordedSeatIdentityInput({
    seat: {
      tool: input.runnerName,
      model: input.model,
      axes: input.axes ?? [],
      kind: input.backendKind,
    },
    role: input.role,
    cache: modelCacheStore,
  });
}

export function formatRecordedSeatIdentity(
  input: Parameters<typeof recordedSeatIdentityInput>[0],
): string | null {
  const identity = recordedSeatIdentityInput(input);
  return identity === null ? null : formatSeatIdentity(identity);
}

export function formatRecordedSeatChangeIdentities(
  from: Parameters<typeof resolveSeatChangeIdentities>[0]['from'],
  to: Parameters<typeof resolveSeatChangeIdentities>[0]['to'],
  role: ActiveRunnerRole,
): Readonly<{ from: string; to: string }> {
  return resolveSeatChangeIdentities({ from, to, role, cache: modelCacheStore });
}
