import {
  CREW_SEAT_IDS,
  CREW_SEAT_LABELS,
  REVIEW_NONE,
  type CrewSeatId,
} from '../../crew/identity.js';
import { sameSeatIds, type SeatIds } from '../../crew/seat-ids.js';
import type { Config } from '../../schemas/config.js';
import type { SessionRef } from '../../types/session-ref.js';
import { loadState } from '../persistence.js';
import {
  type SeatIdentities,
  seatIdentitiesFromConfig,
  readSeatIdentityRecord,
  writeSeatIdentities,
} from './record.js';

export type SeatChange = Readonly<{
  seat: CrewSeatId;
  before: string;
  after: string;
  beforeIds?: SeatIds | undefined;
  afterIds?: SeatIds | undefined;
  /** The BUILD profile that moved, when it is not the default one. */
  profile?: string | undefined;
}>;

export function seatIdentityChanges(
  recorded: SeatIdentities | null,
  current: SeatIdentities,
): SeatChange[] {
  if (recorded === null) return [];
  const changes: SeatChange[] = [];
  for (const seat of CREW_SEAT_IDS) {
    const same =
      recorded.ids === undefined || current.ids === undefined
        ? recorded[seat] === current[seat]
        : sameSeatIds(recorded.ids[seat], current.ids[seat]);
    if (same) continue;
    changes.push({
      seat,
      before: recorded[seat],
      after: current[seat],
      ...(recorded.ids !== undefined && { beforeIds: recorded.ids[seat] }),
      ...(current.ids !== undefined && { afterIds: current.ids[seat] }),
    });
  }
  // A profile only one side names was added or removed, which moves no brief's seat.
  for (const [profile, before] of Object.entries(recorded.buildProfiles ?? {})) {
    const after = current.buildProfiles?.[profile];
    if (after === undefined || sameSeatIds(before.ids, after.ids)) continue;
    changes.push({
      seat: 'build',
      before: before.identity,
      after: after.identity,
      beforeIds: before.ids,
      afterIds: after.ids,
      profile,
    });
  }
  return changes;
}

export function formatSeatChangeNotice(change: SeatChange): string {
  const consequence =
    change.seat === 'plan'
      ? 'context will be rebuilt'
      : change.seat === 'review' && change.after === REVIEW_NONE.mark
        ? 'no seat reviews the rest of the run'
        : 'the rest of the run uses the new seat';
  return `${CREW_SEAT_LABELS[change.seat]} seat changed ${change.before} → ${change.after}; ${consequence}`;
}

/** Whether a record's ids predate the runner kind, and so cannot name their own side. */
function idsLackKind(ids: NonNullable<SeatIdentities['ids']>): boolean {
  return CREW_SEAT_IDS.some((seat) => ids[seat].kind === undefined);
}

/**
 * The one home for maintaining the record: it reports what moved since the last
 * run and re-records the crew this run is about to use, so every resume — CLI
 * or in-app — compares against the run that really happened.
 */
export function reconcileSeatIdentities(
  ref: SessionRef,
  config: Config,
  displayNames?: Partial<Record<CrewSeatId, string>>,
): SeatChange[] {
  const current = seatIdentitiesFromConfig(config, displayNames);
  const recorded = readSeatIdentityRecord(ref);
  // A record without ids was spelled without catalog labels, so it compares against that spelling.
  const changes = seatIdentityChanges(
    recorded,
    recorded?.ids === undefined ? seatIdentitiesFromConfig(config) : current,
  );
  const relabelled =
    recorded !== null && CREW_SEAT_IDS.some((seat) => recorded[seat] !== current[seat]);
  const missingIds = recorded !== null && recorded.ids === undefined;
  const missingKinds = recorded?.ids !== undefined && idsLackKind(recorded.ids);
  const switchCount = loadState(ref)?.seatSwitches?.length ?? 0;
  const orderChanged = recorded !== null && recorded.switchCount !== switchCount;
  const followChanged = recorded !== null && recorded.reviewSeat !== current.reviewSeat;
  const profilesChanged =
    recorded !== null &&
    JSON.stringify(recorded.buildProfiles) !== JSON.stringify(current.buildProfiles);
  // A record written before the ids, or their kinds, were kept gains them without a notice, so
  // the next move is named on both sides; a catalog label that changed is re-spelled the same way,
  // and so is a review seat that starts or stops following PLAN on the same tool and model.
  if (
    changes.length > 0 ||
    relabelled ||
    missingIds ||
    missingKinds ||
    orderChanged ||
    followChanged ||
    profilesChanged
  ) {
    writeSeatIdentities(ref, current);
  }
  return changes;
}
