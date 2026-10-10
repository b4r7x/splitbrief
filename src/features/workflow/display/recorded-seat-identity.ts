import { formatSeatIdentity, type SeatIds } from '../../../core/crew/identity.js';
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
  const tool =
    input.backendKind === 'cli' || input.backendKind === undefined
      ? (cliToolIdForCommand(input.runnerName) ?? input.runnerName)
      : input.runnerName;
  const displayName =
    input.model === undefined
      ? undefined
      : resolveModelDisplayName({
          providerId: tool,
          model: input.model,
          role: input.role,
          kind: input.backendKind,
          cache: modelCacheStore,
        });
  return formatSeatIdentity({
    seat: { tool, model: input.model, axes: input.axes ?? [], kind: input.backendKind },
    displayName,
  });
}
