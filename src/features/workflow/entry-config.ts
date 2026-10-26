import { readImplementerProfileConfig } from '../../core/config/accessors/implementer-profiles.js';
import { sameSeatIds, seatIdsOf } from '../../core/crew/identity.js';
import type { Config } from '../../core/schemas/config.js';
import type { WorkflowState } from '../../core/schemas/workflow.js';
import { seatIdentitiesFromConfig, seatIdentityChanges } from '../../core/state/seats.js';
import { configStore } from '../../stores/project/config.js';

/**
 * Whether the saved config moved the BUILD seat of the profile a recovery pinned the brief to. The
 * crew's BUILD seat is the default profile, so a save to a named profile is not a crew seat change.
 */
function pinnedSeatSaved(run: Config, saved: Config, state: WorkflowState): boolean {
  const profile = state.retryProfile?.profile;
  if (profile === undefined) return false;
  const before = readImplementerProfileConfig(run, profile);
  const after = readImplementerProfileConfig(saved, profile);
  return (
    before !== undefined && after !== undefined && !sameSeatIds(seatIdsOf(before), seatIdsOf(after))
  );
}

/**
 * The config the run's next entry runs on, read after a hand edit of the file is loaded: the saved
 * config when a seat was saved since the run was prepared, else the prepared config. Both carry this
 * process's seat flags.
 */
export function nextEntryConfig(
  input: Readonly<{ configOfRun: Config; prepared: Config; state: WorkflowState | undefined }>,
): Readonly<{ config: Config; seatsSaved: boolean }> {
  configStore.reloadIfChanged();
  const saved = configStore.get().config;
  const seatsSaved =
    saved !== null &&
    (seatIdentityChanges(
      seatIdentitiesFromConfig(input.configOfRun),
      seatIdentitiesFromConfig(saved),
    ).length > 0 ||
      (input.state !== undefined && pinnedSeatSaved(input.configOfRun, saved, input.state)));
  return { config: seatsSaved ? saved : input.prepared, seatsSaved };
}
