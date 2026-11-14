import { readActiveRunner } from '../../../core/config/accessors/active-runner.js';
import { type CrewSeatId, sameSeatCandidate } from '../../../core/crew/identity.js';
import { CREW_SEAT_ROLES } from '../../../core/crew/seats.js';
import {
  type OverlayType,
  seatPickerOverlayFor,
  toolRowFocus,
} from '../../../core/navigation/types.js';
import type { Config } from '../../../core/schemas/config.js';
import type { SeatSwapCandidate } from '../../../core/schemas/recovery/schemas.js';
import { configStore } from '../../../stores/project/config.js';
import { overlayStore } from '../../../stores/ui/overlay.js';
import { pickerViewStore } from '../../../stores/ui/picker-view.js';

/**
 * Resolves once the picker has closed, or the run is aborted while it is open, with whether
 * the picker took a row. The flag is read at the close itself: the picker's unmount resets it.
 */
function overlayClosed(overlay: OverlayType, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    let unsubscribe = (): void => {};
    const settle = (): void => {
      unsubscribe();
      signal.removeEventListener('abort', settle);
      resolve(pickerViewStore.get().committed);
    };
    unsubscribe = overlayStore.subscribe(() => {
      if (overlayStore.get().active !== overlay) settle();
    });
    signal.addEventListener('abort', settle);
    if (signal.aborted || overlayStore.get().active !== overlay) settle();
  });
}

/**
 * The seat as a config has it, on the BUILD profile the halt named; a seat that runs no CLI
 * tool cannot be swapped.
 */
export function seatIn(
  config: Config | null,
  seat: CrewSeatId,
  profile: string | undefined,
): SeatSwapCandidate | undefined {
  if (config === null) return undefined;
  const runner = readActiveRunner({ config, role: CREW_SEAT_ROLES[seat], profile });
  if (runner.kind !== 'cli') return undefined;
  return {
    tool: runner.tool,
    ...(runner.model !== undefined && { model: runner.model }),
    ...(runner.effort !== undefined && { effort: runner.effort }),
    ...(runner.variant !== undefined && { variant: runner.variant }),
  };
}

/**
 * The chosen candidate is preselected in the seat's own picker, the one place a
 * seat's model and effort are chosen: the picker opens on its tool row with its
 * model and effort drafted. A row the picker takes is saved to the config of record,
 * and the swap is read back from it. A picker closed with no row taken (Escape, also
 * after Ctrl+D saved a deleted custom model) is a cancelled swap, and so is a take of
 * a `kept` seat: the seat the halted call ran on — same tool, model, effort and
 * variant — or the configured seat it was prepared from, which may leave its model to
 * the tool. A take of the seat a save under the halt already chose is a swap, also
 * after the run is opened again. A BUILD halt names the profile that failed: the picker
 * reads the open halt and saves to that profile, and the swap is read from it.
 */
export async function pickSwappedSeat(
  seat: CrewSeatId,
  candidate: SeatSwapCandidate,
  kept: SeatSwapCandidate[],
  signal: AbortSignal,
  profile: string | undefined,
): Promise<SeatSwapCandidate | undefined> {
  const overlay = seatPickerOverlayFor(CREW_SEAT_ROLES[seat]);
  if (candidate.model !== undefined) {
    pickerViewStore.expand(
      candidate.model,
      candidate.model,
      candidate.effort ?? candidate.variant ?? null,
    );
  }
  pickerViewStore.setCommitted(false);
  overlayStore.open(overlay, toolRowFocus(candidate.tool));
  if (!(await overlayClosed(overlay, signal))) return undefined;
  const after = seatIn(configStore.get().config, seat, profile);
  if (after === undefined) return undefined;
  if (kept.some((seatKept) => sameSeatCandidate(after, seatKept))) return undefined;
  return after;
}
