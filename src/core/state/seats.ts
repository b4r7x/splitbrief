/**
 * The seat file records the crew the session last ran with, one formatted
 * identity per seat, so a resume can say what changed under the run instead of
 * silently continuing on a different tool. Every run that actually starts
 * rewrites it (`reconcileSeatIdentities`), so the comparison is against the
 * previous run and not against the first; a resume that never gets past
 * preparation leaves the record alone. It sits beside state.json rather than
 * inside it because a seat identity is a display string, not machine state the
 * state machine transitions over.
 */
import { join } from 'node:path';
import { z } from 'zod';
import type { Config } from '../schemas/config.js';
import { CREW_SEAT_IDS, CREW_SEAT_LABELS, sameSeatIds, seatIdsOf } from '../crew/identity.js';
import type { CrewSeatId, SeatIds } from '../crew/identity.js';
import { deriveCrewSeats } from '../crew/seats.js';
import { RUNNER_KINDS } from '../schemas/enums.js';
import type { WorkflowState } from '../schemas/workflow.js';
import { resolveCliModel } from '../providers/automatic-model.js';
import { resolveAutoModel } from '../providers/model-selection.js';
import type { SeatIdentity } from '../providers/seat-identity.js';
import { sessionError } from '../sessions/errors.js';
import { SPLITBRIEF_DIR, SESSIONS_DIR, SEATS_FILE } from '../paths.js';
import type { SessionRef } from '../types/session-ref.js';
import { confinedReadFile, confinedWriteFile } from '../../lib/confined-fs.js';
import { assertSessionDirConfined } from '../sessions/confinement.js';
import { loadState } from './persistence.js';

const SeatIdsSchema = z.object({
  tool: z.string(),
  model: z.string().optional(),
  axes: z.array(z.string()).readonly(),
  kind: z.enum(RUNNER_KINDS).optional(),
});

export const SeatIdentitiesSchema = z.object({
  plan: z.string(),
  build: z.string(),
  review: z.string(),
  /**
   * The ids each identity was spelled from, so a notice can name both sides of a move in the
   * catalog's words. The ids are the comparison: a model the catalog renames never reads as a
   * seat that moved. Records written before these were kept have none and compare by identity,
   * and records written before the runner kind was kept carry ids without one.
   */
  ids: z.object({ plan: SeatIdsSchema, build: SeatIdsSchema, review: SeatIdsSchema }).optional(),
  /**
   * Whether the review seat followed PLAN (no reviewer of its own), which the ids cannot say: a
   * reviewer set to the planner's tool and model has the same ids. Records written before it have none.
   */
  reviewFollowsPlan: z.boolean().optional(),
});

export type SeatIdentities = z.infer<typeof SeatIdentitiesSchema>;

const SeatIdentityRecordSchema = SeatIdentitiesSchema.extend({
  switchCount: z.number().int().nonnegative().optional(),
});

export type SeatChange = Readonly<{
  seat: CrewSeatId;
  before: string;
  after: string;
  beforeIds?: SeatIds | undefined;
  afterIds?: SeatIds | undefined;
}>;

/** The crew as the surfaces spell it: `displayNames` are the catalog labels the crew rows show. */
export function seatIdentitiesFromConfig(
  config: Config,
  displayNames?: Partial<Record<CrewSeatId, string>>,
): SeatIdentities {
  const [plan, build, review] = deriveCrewSeats({ config, displayNames });
  return {
    plan: plan.model,
    build: build.model,
    review: review.model,
    ids: {
      plan: seatIdsOf(plan.runner),
      build: seatIdsOf(build.runner),
      review: seatIdsOf(review.runner),
    },
    reviewFollowsPlan: review.source === 'planner',
  };
}

function seatsRelativePath(sessionId: string): string {
  return join(SPLITBRIEF_DIR, SESSIONS_DIR, sessionId, SEATS_FILE);
}

export function readSeatIdentityRecord(
  ref: SessionRef,
): z.infer<typeof SeatIdentityRecordSchema> | null {
  const raw = confinedReadFile(ref.projectDir, seatsRelativePath(ref.sessionId));
  if (raw === null) return null;
  try {
    const parsed = SeatIdentityRecordSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function readSeatIdentities(ref: SessionRef): SeatIdentities | null {
  const record = readSeatIdentityRecord(ref);
  if (record === null) return null;
  const { switchCount: _switchCount, ...seats } = record;
  return seats;
}

export function writeSeatIdentities(ref: SessionRef, seats: SeatIdentities): void {
  assertSessionDirConfined(ref.projectDir, ref.sessionId);
  // Switches append to state before resume records the crew; this count preserves that order.
  const switchCount = loadState(ref)?.seatSwitches?.length ?? 0;
  confinedWriteFile(
    ref.projectDir,
    seatsRelativePath(ref.sessionId),
    `${JSON.stringify({ ...seats, switchCount }, null, 2)}\n`,
  );
}

/** Records the seats a run starts on; a session that already has a record keeps it. */
export function recordSeatIdentities(
  ref: SessionRef,
  config: Config,
  displayNames?: Partial<Record<CrewSeatId, string>>,
): void {
  if (readSeatIdentities(ref) !== null) return;
  writeSeatIdentities(ref, seatIdentitiesFromConfig(config, displayNames));
}

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
  return changes;
}

export function formatSeatChangeNotice(change: SeatChange): string {
  const consequence =
    change.seat === 'plan' ? 'context will be rebuilt' : 'the rest of the run uses the new seat';
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
  const followChanged =
    recorded !== null && recorded.reviewFollowsPlan !== current.reviewFollowsPlan;
  // A record written before the ids, or their kinds, were kept gains them without a notice, so
  // the next move is named on both sides; a catalog label that changed is re-spelled the same way,
  // and so is a review seat that starts or stops following PLAN on the same tool and model.
  if (
    changes.length > 0 ||
    relabelled ||
    missingIds ||
    missingKinds ||
    orderChanged ||
    followChanged
  ) {
    writeSeatIdentities(ref, current);
  }
  return changes;
}

function recordedModel(seat: SeatIds): string | undefined {
  return seat.kind === 'api'
    ? resolveAutoModel(seat.model, seat.tool)
    : resolveCliModel(seat.model, seat.tool);
}

/**
 * The crew a run ran with, for its closed record: the seats of its latest pass, never the config
 * saved since. The planner holds the review seat when the record says it followed PLAN. A record
 * written before that was kept reads it as following PLAN only when both seats are the same and
 * the run started without a reviewer. A record written before seat ids were kept reads the seats
 * the state saved at the run's start.
 */
export function recordedSeatIdentity(ref: SessionRef, state: WorkflowState): SeatIdentity {
  const record = readSeatIdentities(ref);
  if (record?.ids === undefined) {
    if (state.plannerTool === undefined || state.implementerTool === undefined) {
      throw sessionError.invalidData(ref.sessionId, 'the run recorded no crew');
    }
    return {
      plannerTool: state.plannerTool,
      plannerModel: state.plannerModel,
      plannerKind: state.plannerKind,
      implementerTool: state.implementerTool,
      implementerModel: state.implementerModel,
      implementerKind: state.implementerKind,
      reviewerTool: state.reviewerTool,
      reviewerModel: state.reviewerModel,
      reviewerKind: state.reviewerKind,
    };
  }
  const ids = record.ids;
  const reviewFollowsPlan =
    record.reviewFollowsPlan ??
    (state.reviewerTool === undefined && sameSeatIds(ids.review, ids.plan));
  return {
    plannerTool: ids.plan.tool,
    plannerModel: recordedModel(ids.plan),
    plannerKind: ids.plan.kind,
    plannerAxes: ids.plan.axes,
    implementerTool: ids.build.tool,
    implementerModel: recordedModel(ids.build),
    implementerKind: ids.build.kind,
    implementerAxes: ids.build.axes,
    ...(!reviewFollowsPlan && {
      reviewerTool: ids.review.tool,
      reviewerModel: recordedModel(ids.review),
      reviewerKind: ids.review.kind,
      reviewerAxes: ids.review.axes,
    }),
  };
}
